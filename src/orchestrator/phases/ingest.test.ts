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

test("local stop saves the in-flight receipt and prevents later sessions from uploading", async () => {
  const { startRun, requestStop, endRun } = await import("../../server/runState")
  const directory = mkdtempSync(join(tmpdir(), "memorybench-stop-"))
  const manager = new CheckpointManager(directory)
  const id = "stop-between-sessions"
  startRun(id)
  try {
    const checkpoint = manager.create(id, "fake", "fake", "gpt-4o", "gpt-4o")
    const question = {
      questionId: "q",
      question: "Where?",
      groundTruth: "Boston",
      questionType: "single",
      haystackSessionIds: ["s1", "s2"],
    }
    manager.initQuestion(checkpoint, "q", `q-${id}`, question)
    const benchmark: Benchmark = {
      name: "fake",
      load: async () => {},
      getQuestions: () => [question],
      getHaystackSessions: () => ["s1", "s2"].map((sessionId) => ({ sessionId, messages: [] })),
      getGroundTruth: () => "Boston",
      getQuestionTypes: () => ({}),
    }
    const calls: string[] = []
    const provider: Provider = {
      name: "fake",
      initialize: async () => {},
      clear: async () => {},
      search: async () => [],
      ingest: async ([session]) => {
        calls.push(session.sessionId)
        requestStop(id)
        return { documentIds: [session.sessionId] }
      },
      awaitIndexing: async () => {},
    }
    await expect(runIngestPhase(provider, benchmark, checkpoint, manager)).rejects.toThrow(
      "stopped by user"
    )
    await manager.flush()
    const saved = manager.load(id)!
    expect(calls).toEqual(["s1"])
    expect(saved.questions.q.phases.ingest.completedSessions).toEqual(["s1"])
    expect(saved.questions.q.phases.ingest.ingestResult?.documentIds).toEqual(["s1"])
    endRun(id)
    await runIngestPhase(provider, benchmark, saved, manager)
    expect(calls).toEqual(["s1", "s2"])
  } finally {
    endRun(id)
    await manager.flush()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("local stop interrupts readiness at the next provider progress callback", async () => {
  const { startRun, requestStop, endRun } = await import("../../server/runState")
  const directory = mkdtempSync(join(tmpdir(), "memorybench-stop-index-"))
  const manager = new CheckpointManager(directory)
  const id = "stop-readiness"
  startRun(id)
  try {
    const checkpoint = manager.create(id, "fake", "fake", "gpt-4o", "gpt-4o")
    manager.initQuestion(checkpoint, "q", `q-${id}`, {
      question: "Where?",
      groundTruth: "Boston",
      questionType: "single",
    })
    checkpoint.questions.q.phases.ingest = {
      status: "completed",
      completedSessions: ["s1"],
      ingestResult: { documentIds: ["receipt"] },
    }
    let polledAgain = false
    const provider: Provider = {
      name: "fake",
      initialize: async () => {},
      clear: async () => {},
      search: async () => [],
      ingest: async () => ({ documentIds: [] }),
      awaitIndexing: async (_result, _tag, progress) => {
        requestStop(id)
        progress?.({ completedIds: [], failedIds: [], total: 1 })
        polledAgain = true
      },
    }
    await expect(runIndexingPhase(provider, checkpoint, manager)).rejects.toThrow("stopped by user")
    expect(polledAgain).toBe(false)
    expect(checkpoint.questions.q.phases.indexing.status).toBe("failed")
  } finally {
    endRun(id)
    await manager.flush()
    rmSync(directory, { recursive: true, force: true })
  }
})
