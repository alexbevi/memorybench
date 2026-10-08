import { estimateWorkload } from "./workload"
import { admitWork, backlogPolicy, type BacklogPolicy } from "./admission"
import { assertRunNotStopped } from "../server/runState"
import { monitorQueue } from "./queue"
import { assertRequestedPhasesComplete } from "./completion"
import { captureProvenance, PROCESS_PROVENANCE, datasetHash } from "../utils/provenance"
import { selectQuestionsBySampling, DEFAULT_SAMPLE_SEED } from "./sampling"
import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { JudgeName } from "../types/judge"
import type { RunCheckpoint, SamplingConfig } from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import { createProvider } from "../providers"
import { createBenchmark } from "../benchmarks"
import { createJudge } from "../judges"
import { CheckpointManager } from "./checkpoint"
import { getProviderConfig, getJudgeConfig } from "../utils/config"
import { resolveModel } from "../utils/models"
import { logger } from "../utils/logger"
import { runIngestPhase } from "./phases/ingest"
import { runIndexingPhase } from "./phases/indexing"
import { runSearchPhase } from "./phases/search"
import { runAnswerPhase } from "./phases/answer"
import { runEvaluatePhase } from "./phases/evaluate"
import { generateReport, saveReport, printReport } from "./phases/report"

export interface OrchestratorOptions {
  backlogPolicy?: BacklogPolicy
  searchMeasurement?: import("./search-measurement").SearchMeasurement
  expectedDatasetHash?: string
  provider: ProviderName
  benchmark: BenchmarkName
  judgeModel: string
  runId: string
  answeringModel?: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  force?: boolean
  questionIds?: string[]
  phases?: ("ingest" | "indexing" | "search" | "answer" | "evaluate" | "report")[]
}

export class Orchestrator {
  private checkpointManager: CheckpointManager

  constructor() {
    this.checkpointManager = new CheckpointManager()
  }

  async run(options: OrchestratorOptions): Promise<void> {
    const {
      provider: providerName,
      benchmark: benchmarkName,
      judgeModel,
      runId,
      answeringModel = "gpt-4o",
      limit,
      sampling,
      concurrency,
      force = false,
      questionIds,
      phases = ["ingest", "indexing", "search", "answer", "evaluate", "report"],
    } = options

    const judgeModelInfo = resolveModel(judgeModel)
    const judgeName = judgeModelInfo.provider as JudgeName

    logger.info(`Starting MemoryBench run: ${providerName} + ${benchmarkName}`)
    logger.info(`Run ID: ${runId}`)
    logger.info(
      `Judge: ${judgeModelInfo.displayName} (${judgeModelInfo.id}), Answering Model: ${answeringModel}`
    )
    logger.info(`Force: ${force}, Phases: ${phases?.join(", ") || "all"}`)
    if (sampling) {
      logger.info(`Sampling config received: ${JSON.stringify(sampling)}`)
      if (sampling.mode === "sample") {
        logger.info(
          `Sampling: ${sampling.perCategory} per category (${sampling.sampleType || "consecutive"})`
        )
      } else if (sampling.mode === "limit") {
        logger.info(`Limit: ${sampling.limit} questions`)
      } else {
        logger.info(`Selection: full (all questions)`)
      }
    } else if (limit) {
      logger.info(`Limit: ${limit} questions`)
    } else {
      logger.info(`No sampling or limit provided`)
    }

    if (force && this.checkpointManager.exists(runId)) {
      this.checkpointManager.delete(runId)
      logger.info("Cleared existing checkpoint (--force)")
    }

    let checkpoint!: RunCheckpoint
    let effectiveLimit: number | undefined
    let targetQuestionIds: string[] | undefined
    let isNewRun = false

    if (!this.checkpointManager.exists(runId)) {
      isNewRun = true
      checkpoint = this.checkpointManager.create(
        runId,
        providerName,
        benchmarkName,
        judgeModel,
        answeringModel,
        { limit, sampling, concurrency, status: "initializing" }
      )
      checkpoint.searchMeasurement = options.searchMeasurement
      this.checkpointManager.save(checkpoint)
      logger.info("Created checkpoint (initializing)")
    }

    const benchmark = createBenchmark(benchmarkName)
    await benchmark.load()
    const allQuestions = benchmark.getQuestions()
    if (options.expectedDatasetHash && datasetHash(benchmark) !== options.expectedDatasetHash)
      throw new Error("Dataset differs from the comparison manifest; start a new comparison")

    if (this.checkpointManager.exists(runId) && !isNewRun) {
      checkpoint = this.checkpointManager.load(runId)!

      effectiveLimit = checkpoint.limit
      targetQuestionIds = checkpoint.targetQuestionIds

      if (!targetQuestionIds) {
        const startedQuestions = Object.values(checkpoint.questions)
          .filter((q) => Object.values(q.phases).some((p) => p.status !== "pending"))
          .map((q) => q.questionId)

        if (startedQuestions.length > 0) {
          const pendingQuestions = Object.values(checkpoint.questions)
            .filter((q) => Object.values(q.phases).every((p) => p.status === "pending"))
            .map((q) => q.questionId)

          if (limit) {
            const remainingSlots = limit - startedQuestions.length
            targetQuestionIds = [
              ...startedQuestions,
              ...pendingQuestions.slice(0, Math.max(0, remainingSlots)),
            ]
            effectiveLimit = limit
            logger.warn(
              `Old checkpoint detected. Using CLI limit (${limit}) to determine target questions.`
            )
          } else {
            targetQuestionIds = startedQuestions
            logger.warn(
              `Old checkpoint without stored limit. Only processing ${startedQuestions.length} already-started questions.`
            )
          }

          checkpoint.limit = effectiveLimit
          checkpoint.targetQuestionIds = targetQuestionIds
          this.checkpointManager.save(checkpoint)
        } else {
          if (limit) {
            const limitedQuestions = allQuestions.slice(0, limit).map((q) => q.questionId)
            targetQuestionIds = limitedQuestions
            effectiveLimit = limit
            checkpoint.limit = limit
            checkpoint.targetQuestionIds = targetQuestionIds
            this.checkpointManager.save(checkpoint)
            logger.warn(
              `Old checkpoint with no progress. Applying limit (${limit}) to first ${limit} questions.`
            )
          }
        }
      }

      const summary = this.checkpointManager.getSummary(checkpoint)
      const targetCount = targetQuestionIds?.length || summary.total

      const inProgressQuestions = Object.values(checkpoint.questions)
        .filter((q) => Object.values(q.phases).some((p) => p.status === "in_progress"))
        .map((q) => q.questionId)

      logger.info(
        `Resuming from checkpoint: ${summary.ingested}/${targetCount} ingested, ${summary.evaluated}/${targetCount} evaluated`
      )
      if (inProgressQuestions.length > 0) {
        logger.info(`In-progress questions: ${inProgressQuestions.join(", ")}`)
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    } else {
      logger.info(
        `New run path: isNewRun=${isNewRun}, sampling=${JSON.stringify(sampling)}, limit=${limit}`
      )
      effectiveLimit = limit

      if (questionIds && questionIds.length > 0) {
        logger.info(`Using explicit questionIds: ${questionIds.length} questions`)
        targetQuestionIds = questionIds
      } else if (sampling) {
        logger.info(`Using sampling mode: ${sampling.mode}`)
        targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
        checkpoint.sampling =
          sampling.mode === "sample"
            ? { ...sampling, seed: sampling.seed ?? DEFAULT_SAMPLE_SEED }
            : sampling
        logger.info(
          `Sampling selected ${targetQuestionIds.length} questions from ${allQuestions.length} total`
        )
      } else if (effectiveLimit) {
        logger.info(`Using limit: ${effectiveLimit}`)
        targetQuestionIds = allQuestions.slice(0, effectiveLimit).map((q) => q.questionId)
      } else {
        logger.info(`No sampling/limit specified, using all ${allQuestions.length} questions`)
      }

      checkpoint.targetQuestionIds = targetQuestionIds
      checkpoint.limit = effectiveLimit

      const questionsToInit = targetQuestionIds
        ? allQuestions.filter((q) => targetQuestionIds!.includes(q.questionId))
        : allQuestions

      for (const q of questionsToInit) {
        const containerTag = `${q.questionId}-${checkpoint.dataSourceRunId}`
        this.checkpointManager.initQuestion(checkpoint, q.questionId, containerTag, {
          question: q.question,
          groundTruth: q.groundTruth,
          questionType: q.questionType,
          questionDate: q.metadata?.questionDate as string | undefined,
        })
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    }

    if (checkpoint.provenance) {
      if (checkpoint.provenance.datasetHash !== datasetHash(benchmark))
        throw new Error("Dataset changed since this run started; use a fresh run ID")
      if (checkpoint.provenance.code.sourceHash !== PROCESS_PROVENANCE.sourceHash)
        throw new Error(
          "Benchmark code changed since this run started; use a fresh run ID to avoid mixing policies"
        )
    } else if (isNewRun) {
      checkpoint.provenance = captureProvenance(
        benchmark,
        targetQuestionIds ?? allQuestions.map((q) => q.questionId),
        getProviderConfig(providerName)
      )
      checkpoint.provenance.measurement = `after-readiness; explicit-warmups=${checkpoint.searchMeasurement?.warmupRequests ?? 0}; measured-repetitions=${checkpoint.searchMeasurement?.repetitions ?? 1}; server-cache-state-uncontrolled`
      this.checkpointManager.save(checkpoint)
    } else {
      logger.warn("Legacy run has no provenance; do not compare it as a controlled run")
    }
    const provider = createProvider(providerName)
    checkpoint.workload = estimateWorkload(
      benchmark,
      targetQuestionIds ?? allQuestions.map((q) => q.questionId),
      provider
    )
    logger.info("Planned workload", { ...checkpoint.workload })

    await provider.initialize(getProviderConfig(providerName))
    if (
      !Object.values(checkpoint.questions).some((q) => q.phases.indexing.status === "completed")
    ) {
      checkpoint.readinessPolicy = provider.readinessPolicy
      this.checkpointManager.save(checkpoint)
    }
    logger.info(`Readiness method: ${checkpoint.readinessPolicy?.method ?? "unrecorded"}`)
    const stopQueueMonitor = await monitorQueue(provider, (observation) => {
      checkpoint.queue = {
        baseline: checkpoint.queue?.baseline ?? observation,
        latest: observation,
      }
      this.checkpointManager.save(checkpoint)
    })
    try {
      if (phases.includes("ingest")) {
        await admitWork(
          provider,
          backlogPolicy(options.backlogPolicy ?? checkpoint.admission?.policy),
          (state) => {
            checkpoint.admission = state
            this.checkpointManager.save(checkpoint)
            if (state.decision === "warned")
              logger.warn("Proceeding with backlog or unknown queue state; counts are service-wide")
          },
          { checkStop: () => assertRunNotStopped(runId) }
        )
        await runIngestPhase(
          provider,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds
        )
      }

      if (phases.includes("indexing")) {
        await runIndexingPhase(provider, checkpoint, this.checkpointManager, targetQuestionIds)
      }

      if (phases.includes("search")) {
        await runSearchPhase(
          provider,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds
        )
      }

      if (phases.includes("answer")) {
        await runAnswerPhase(
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds,
          provider
        )
      }

      if (phases.includes("evaluate")) {
        const judge = createJudge(judgeName)
        const judgeConfig = getJudgeConfig(judgeName)
        judgeConfig.model = judgeModel
        await judge.initialize(judgeConfig)
        await runEvaluatePhase(
          judge,
          benchmark,
          checkpoint,
          this.checkpointManager,
          targetQuestionIds,
          provider
        )
      }

      try {
        assertRequestedPhasesComplete(
          checkpoint,
          phases,
          targetQuestionIds ?? allQuestions.map((q) => q.questionId)
        )
      } catch (error) {
        this.checkpointManager.updateStatus(checkpoint, "failed")
        await this.checkpointManager.flush(checkpoint.runId)
        throw error
      }

      if (phases.includes("report")) {
        const report = generateReport(benchmark, checkpoint)
        saveReport(report)
        printReport(report)
      }

      // Flush all pending checkpoint saves before marking as complete
      await this.checkpointManager.flush(checkpoint.runId)
      this.checkpointManager.updateStatus(checkpoint, "completed")
      logger.success("Run complete!")
    } finally {
      await stopQueueMonitor()
      await this.checkpointManager.flush(checkpoint.runId)
    }
  }

  async ingest(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({
      ...options,
      judgeModel: options.judgeModel || "gpt-4o",
      phases: ["ingest", "indexing"],
    })
  }

  async search(
    options: Omit<OrchestratorOptions, "judgeModel" | "phases"> & { judgeModel?: string }
  ): Promise<void> {
    await this.run({ ...options, judgeModel: options.judgeModel || "gpt-4o", phases: ["search"] })
  }

  async evaluate(options: OrchestratorOptions): Promise<void> {
    await this.run({ ...options, phases: ["answer", "evaluate", "report"] })
  }

  async testQuestion(options: OrchestratorOptions & { questionId: string }): Promise<void> {
    await this.run({
      ...options,
      questionIds: [options.questionId],
      phases: ["search", "answer", "evaluate", "report"],
    })
  }

  getStatus(runId: string): void {
    const checkpoint = this.checkpointManager.load(runId)
    if (!checkpoint) {
      logger.error(`No run found: ${runId}`)
      return
    }

    const summary = this.checkpointManager.getSummary(checkpoint)
    console.log("\n" + "=".repeat(50))
    console.log(`Run: ${runId}`)
    console.log(`Provider: ${checkpoint.provider}`)
    console.log(`Benchmark: ${checkpoint.benchmark}`)
    console.log("=".repeat(50))
    console.log(`Total Questions: ${summary.total}`)
    console.log(`Ingested: ${summary.ingested}`)
    console.log(`Indexed: ${summary.indexed}`)
    console.log(`Searched: ${summary.searched}`)
    console.log(`Answered: ${summary.answered}`)
    console.log(`Evaluated: ${summary.evaluated}`)
    console.log("=".repeat(50) + "\n")
  }
}

export const orchestrator = new Orchestrator()
export { CheckpointManager } from "./checkpoint"
