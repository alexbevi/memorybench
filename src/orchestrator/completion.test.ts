import { expect, test } from "bun:test"
import { assertRequestedPhasesComplete } from "./completion"
import { runEvaluatePhase } from "./phases/evaluate"
import type { RunCheckpoint, QuestionCheckpoint } from "../types/checkpoint"
import type { Benchmark } from "../types/benchmark"
import type { Judge } from "../types/judge"
import type { CheckpointManager } from "./checkpoint"

function fixture() {
  const question = { questionId: "q", phases: {
    ingest: { status: "completed" }, indexing: { status: "completed" },
    search: { status: "completed" }, answer: { status: "completed", hypothesis: "Paris" },
    evaluate: { status: "pending" },
  } } as QuestionCheckpoint
  return { questions: { q: question } } as unknown as RunCheckpoint
}

test("incomplete evaluations block completion and reports; explicit phase subsets can complete", () => {
  const checkpoint = fixture()
  expect(() => assertRequestedPhasesComplete(checkpoint, ["evaluate", "report"], ["q"])).toThrow("q:evaluate")
  expect(() => assertRequestedPhasesComplete(checkpoint, ["report"], ["q"])).toThrow("q:evaluate")
  expect(() => assertRequestedPhasesComplete(checkpoint, ["ingest"], ["q"])).not.toThrow()
  expect(() => assertRequestedPhasesComplete(checkpoint, ["ingest"], ["missing"])).toThrow("missing:ingest")
  checkpoint.questions.q.phases.evaluate.status = "completed"
  expect(() => assertRequestedPhasesComplete(checkpoint, ["evaluate", "report"], ["q"])).not.toThrow()
  checkpoint.questions.q.phases.answer.hypothesis = " "
  expect(() => assertRequestedPhasesComplete(checkpoint, ["report"], ["q"])).toThrow("q:evaluate")
})

test("evaluate explicitly rejects legacy empty answers without calling the judge", async () => {
  const checkpoint = fixture()
  checkpoint.questions.q.phases.answer.hypothesis = ""
  const benchmark = { getQuestions: () => [{ questionId: "q" }] } as unknown as Benchmark
  const manager = { updatePhase: (_: unknown, id: string, phase: "answer" | "evaluate", updates: object) => {
    Object.assign(checkpoint.questions[id].phases[phase], updates)
  } } as unknown as CheckpointManager
  await expect(runEvaluatePhase({} as Judge, benchmark, checkpoint, manager)).rejects.toThrow("Resume from the answer phase")
  expect(checkpoint.questions.q.phases.answer.status).toBe("failed")
  expect(checkpoint.questions.q.phases.evaluate.status).toBe("failed")
})
