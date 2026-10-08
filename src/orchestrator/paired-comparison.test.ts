import { test, expect } from "bun:test"
import { pairedComparisons } from "./paired-comparison"
import type { BenchmarkResult } from "../types/unified"
function report(scores: number[]): BenchmarkResult {
  return {
    benchmark: "locomo",
    judge: "gpt-5-mini",
    answeringModel: "gpt-5",
    evaluations: scores.map((score, i) => ({
      questionId: `conv-26-q${i}`,
      question: `Q${i}`,
      groundTruth: "answer",
      score,
      hypothesis: "test",
    })),
  } as BenchmarkResult
}
test("paired results expose one-question margins and legacy/small-sample limits", () => {
  const [pair] = pairedComparisons([
    { provider: "a", report: report([1, 1, 0, 0]) },
    { provider: "b", report: report([1, 0, 1, 1]) },
  ])
  expect(pair.leftOnlyCorrect).toBe(1)
  expect(pair.rightOnlyCorrect).toBe(2)
  expect(pair.accuracyDifference).toBe(-0.25)
  expect(pair.disagreements).toHaveLength(3)
  expect(pair.warnings.some((w) => w.includes("1/10"))).toBe(true)
  expect(pair.warnings.some((w) => w.includes("provenance"))).toBe(true)
})
test("mismatched questions are not treated as provider losses", () => {
  const [pair] = pairedComparisons([
    { provider: "a", report: report([1, 1]) },
    { provider: "b", report: report([1]) },
  ])
  expect(pair.matchedQuestions).toBe(1)
  expect(pair.leftOnlyCorrect).toBe(0)
  expect(pair.warnings.some((w) => w.includes("coverage"))).toBe(true)
})
