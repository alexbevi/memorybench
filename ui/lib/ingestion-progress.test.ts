import { expect, test } from "bun:test"
import { getIngestionProgress } from "./ingestion-progress"
import type { QuestionCheckpoint } from "./api"

function question(
  id: string,
  count: number,
  status = "in_progress",
  sessions = 19
): QuestionCheckpoint {
  return {
    questionId: id,
    containerTag: id,
    question: "Where?",
    groundTruth: "Paris",
    questionType: "single-hop",
    sessions: Array.from({ length: sessions }, (_, i) => ({ sessionId: `s${i}`, messageCount: 1 })),
    phases: {
      ingest: { status, completedSessions: Array.from({ length: count }, (_, i) => `s${i}`) },
      indexing: { status: "pending" },
      search: { status: "pending" },
      answer: { status: "pending" },
      evaluate: { status: "pending" },
    },
  }
}

test("partial sessions advance the pipeline before any question finishes", () => {
  const progress = getIngestionProgress({ a: question("a", 9), b: question("b", 9) }, 10)
  expect(progress.percent).toBeCloseTo(9.47368)
  expect(progress.savedSessions).toBe(18)
  expect(progress.active).toEqual([
    { questionId: "a", completed: 9, total: 19 },
    { questionId: "b", completed: 9, total: 19 },
  ])
})

test("progress remains monotonic when the next batch starts", () => {
  const questions = { a: question("a", 19, "completed"), b: question("b", 19, "completed") }
  expect(getIngestionProgress(questions, 10).percent).toBe(20)
  expect(getIngestionProgress({ ...questions, c: question("c", 0) }, 10).percent).toBe(20)
  expect(getIngestionProgress({ ...questions, c: question("c", 1) }, 10).percent).toBeGreaterThan(
    20
  )
})

test("legacy metadata, duplicate receipts, empty runs and failures do not invent progress", () => {
  const legacy = question("old", 3)
  delete legacy.sessions
  expect(getIngestionProgress({ legacy }, 1).percent).toBe(0)
  expect(getIngestionProgress({ legacy }, 1).savedSessions).toBe(3)
  const failed = question("failed", 1, "failed", 2)
  failed.phases.ingest.completedSessions.push("s0", "unknown")
  const result = getIngestionProgress({ failed }, 1)
  expect(result.percent).toBe(50)
  expect(result.savedSessions).toBe(1)
  expect(result.active).toEqual([])
  expect(getIngestionProgress({}, 0).percent).toBe(0)
})
