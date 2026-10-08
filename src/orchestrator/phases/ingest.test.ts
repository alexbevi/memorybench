import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointManager } from "../checkpoint"
import { runIngestPhase } from "./ingest"
import { runIndexingPhase } from "./indexing"
import type { Benchmark } from "../../types/benchmark"
import type { Provider, IngestResult } from "../../types/provider"

test("resume retains receipts from completed sessions through indexing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memorybench-resume-"))
  const manager = new CheckpointManager(directory)
  try {
    const checkpoint = manager.create("resume", "fake", "fake", "gpt-4o", "gpt-4o")
    const question = {
      questionId: "q",
      question: "Where?",
      groundTruth: "Boston",
      questionType: "single",
      haystackSessionIds: ["s1", "s2"],
    }
    manager.initQuestion(checkpoint, "q", "q-resume", question)
    const benchmark: Benchmark = {
      name: "fake",
      load: async () => {},
      getQuestions: () => [question],
      getHaystackSessions: () => ["s1", "s2"].map((sessionId) => ({ sessionId, messages: [] })),
      getGroundTruth: () => "Boston",
      getQuestionTypes: () => ({}),
    }
    const calls: string[] = []
    let fail = true
    let indexed: IngestResult | undefined
    const readiness = {
      totalSessions: 2,
      readySessions: 2,
      waiting: { pending: 0, grace: 0, episodes: 0, search: 0, stability: 0 },
      checkedAt: "2026-10-08T00:00:00Z",
    }
    const provider: Provider = {
      name: "fake",
      initialize: async () => {},
      clear: async () => {},
      search: async () => [],
      ingest: async ([session]) => {
        calls.push(session.sessionId)
        if (session.sessionId === "s2" && fail) throw new Error("interrupted")
        return { documentIds: [session.sessionId], taskIds: [`task-${session.sessionId}`] }
      },
      awaitIndexing: async (result, _tag, progress) => {
        indexed = result
        progress?.({
          completedIds: [...result.documentIds, ...(result.taskIds || [])],
          failedIds: [],
          total: 4,
          readiness,
        })
      },
    }
    await expect(runIngestPhase(provider, benchmark, checkpoint, manager)).rejects.toThrow(
      "interrupted"
    )
    await manager.flush()
    const restored = manager.load("resume")!
    expect(restored.questions.q.phases.ingest.ingestResult).toEqual({
      documentIds: ["s1"],
      taskIds: ["task-s1"],
    })
    fail = false
    await runIngestPhase(provider, benchmark, restored, manager)
    await runIndexingPhase(provider, restored, manager)
    await manager.flush()
    expect(calls).toEqual(["s1", "s2", "s2"])
    expect(indexed).toEqual({ documentIds: ["s1", "s2"], taskIds: ["task-s1", "task-s2"] })
    expect(manager.load("resume")!.questions.q.phases.indexing.status).toBe("completed")
    expect(manager.load("resume")!.questions.q.phases.indexing.readiness).toEqual(readiness)
  } finally {
    await manager.flush()
    rmSync(directory, { recursive: true, force: true })
  }
})
