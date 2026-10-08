import type { Provider, IndexingProgress } from "../../types/provider"
import type { RunCheckpoint, QuestionCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"

function getEpisodeCount(question: QuestionCheckpoint): number {
  const ingestResult = question.phases.ingest.ingestResult
  if (!ingestResult) return 0
  return (ingestResult.documentIds?.length || 0) + (ingestResult.taskIds?.length || 0)
}

class IndexingProgressTracker {
  private progressByQuestion: Map<string, { completed: number; failed: number; total: number }> =
    new Map()
  private totalEpisodes: number = 0
  private lastDisplayed: string = ""

  constructor(questions: QuestionCheckpoint[]) {
    for (const q of questions) {
      const count = getEpisodeCount(q)
      this.totalEpisodes += count
      this.progressByQuestion.set(q.questionId, { completed: 0, failed: 0, total: count })
    }
  }

  update(questionId: string, progress: IndexingProgress): void {
    const current = this.progressByQuestion.get(questionId)
    if (current) {
      this.progressByQuestion.set(questionId, {
        completed: progress.completedIds.length,
        failed: progress.failedIds.length,
        total: progress.total,
      })
    }
    this.display()
  }

  markQuestionDone(questionId: string): void {
    const current = this.progressByQuestion.get(questionId)
    if (current) {
      this.progressByQuestion.set(questionId, {
        completed: current.total,
        failed: current.failed,
        total: current.total,
      })
    }
  }

  getAggregated(): { completed: number; failed: number; total: number } {
    let completed = 0
    let failed = 0
    for (const p of this.progressByQuestion.values()) {
      completed += p.completed
      failed += p.failed
    }
    return { completed, failed, total: this.totalEpisodes }
  }

  display(): void {
    const agg = this.getAggregated()
    const displayStr = `${agg.completed}/${agg.total}/${agg.failed}`
    if (displayStr !== this.lastDisplayed) {
      this.lastDisplayed = displayStr
      if (logger.verbose || !process.stdout.isTTY) {
        logger.info(`Indexing: ${agg.completed}/${agg.total} episodes (${agg.failed} failed)`)
        return
      }
      const percent = agg.total > 0 ? Math.round((agg.completed / agg.total) * 100) : 0
      const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5))
      const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
      process.stdout.write(
        `\r\x1b[36m[${bar}]\x1b[0m ${percent}% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}`
      )
    }
  }

  finish(): void {
    if (logger.verbose || !process.stdout.isTTY) {
      this.display()
      return
    }
    const agg = this.getAggregated()
    const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
    process.stdout.write(
      `\r\x1b[36m[${"█".repeat(20)}]\x1b[0m 100% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}\n`
    )
  }

  getTotalEpisodes(): number {
    return this.totalEpisodes
  }
}

export async function runIndexingPhase(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: CheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const allQuestions = Object.values(checkpoint.questions)
  const targetQuestions = questionIds
    ? allQuestions.filter((q) => questionIds.includes(q.questionId))
    : allQuestions

  const toIndex = targetQuestions.filter(
    (q) => q.phases.ingest.status === "completed" && q.phases.indexing.status !== "completed"
  )

  if (toIndex.length === 0) {
    logger.info("No questions pending indexing")
    return
  }

  const concurrency = resolveConcurrency("indexing", checkpoint.concurrency, provider.concurrency)

  const tracker = new IndexingProgressTracker(toIndex)
  const totalEpisodes = tracker.getTotalEpisodes()

  logger.info(
    `Awaiting indexing for ${toIndex.length} questions, ${totalEpisodes} episodes (concurrency: ${concurrency})...`
  )

  tracker.display()

  await ConcurrentExecutor.execute(
    toIndex,
    concurrency,
    checkpoint.runId,
    "indexing",
    async ({ item: question }) => {
      const ingestResult = question.phases.ingest.ingestResult
      const episodeCount = getEpisodeCount(question)

      if (!ingestResult || episodeCount === 0) {
        checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
          status: "completed",
          completedIds: [],
          failedIds: [],
          completedAt: new Date().toISOString(),
          durationMs: 0,
        })
        tracker.markQuestionDone(question.questionId)
        return { questionId: question.questionId, durationMs: 0 }
      }

      const startTime = Date.now()
      checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
        status: "in_progress",
        completedIds: [],
        failedIds: [],
        startedAt: new Date().toISOString(),
      })

      logger.debug(`[indexing] Started ${question.questionId}`, {
        containerTag: question.containerTag,
        episodes: episodeCount,
      })
      let lastUpdate = startTime
      const heartbeat = setInterval(() => {
        logger.debug(`[indexing] Still waiting for ${question.questionId}`, {
          elapsedMs: Date.now() - startTime,
          sinceLastProgressMs: Date.now() - lastUpdate,
        })
      }, 10000)
      try {
        let lastProgress: IndexingProgress = {
          completedIds: [],
          failedIds: [],
          total: episodeCount,
        }

        await provider.awaitIndexing(ingestResult, question.containerTag, (progress) => {
          lastUpdate = Date.now()
          lastProgress = progress
          tracker.update(question.questionId, progress)

          checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
            status: "in_progress",
            completedIds: progress.completedIds,
            failedIds: progress.failedIds,
          })
        })

        assertNoFailedReceipts(lastProgress)
        const durationMs = Date.now() - startTime
        checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
          status: "completed",
          completedIds: lastProgress.completedIds,
          failedIds: lastProgress.failedIds,
          completedAt: new Date().toISOString(),
          durationMs,
        })

        logger.debug(`[indexing] Completed ${question.questionId}`, { durationMs })
        return { questionId: question.questionId, durationMs }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        checkpointManager.updatePhase(checkpoint, question.questionId, "indexing", {
          status: "failed",
          error,
        })
        logger.error(`\nFailed to index ${question.questionId}: ${error}`)
        throw new Error(
          `Indexing failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`
        )
      } finally {
        clearInterval(heartbeat)
      }
    }
  )

  tracker.finish()
  logger.success("Indexing phase complete")
}

export function assertNoFailedReceipts(progress: IndexingProgress): void {
  if (progress.failedIds.length)
    throw new Error(
      `${progress.failedIds.length} ingestion receipts failed; refusing to evaluate incomplete data`
    )
}
