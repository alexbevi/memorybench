import { test, expect } from "bun:test"
import { selectQuestionsBySampling as sample } from "./sampling"
const questions = Array.from({ length: 100 }, (_, i) => ({
  questionId: `q${i}`,
  questionType: i % 2 ? "a" : "b",
  metadata: { sampleId: `c${Math.floor(i / 10)}` },
}))
test("stratified samples are deterministic, balanced and shared without mutating input", () => {
  const config = {
    mode: "sample" as const,
    sampleType: "stratified" as const,
    perCategory: 10,
    seed: "one",
  }
  const ids = sample(questions, config)
  expect(ids).toEqual(sample(questions, config))
  expect(ids).not.toEqual(sample(questions, { ...config, seed: "two" }))
  expect(new Set(ids).size).toBe(20)
  for (const category of ["a", "b"])
    expect(
      new Set(
        questions
          .filter((q) => ids.includes(q.questionId) && q.questionType === category)
          .map((q) => q.metadata.sampleId)
      ).size
    ).toBe(10)
  expect(questions[0].questionId).toBe("q0")
  expect(sample(questions, { ...config, perCategory: 100 })).toHaveLength(100)
})
test("random samples use a seed and invalid sizes fail", () => {
  const config = {
    mode: "sample" as const,
    sampleType: "random" as const,
    perCategory: 3,
    seed: "repeat",
  }
  expect(sample(questions, config)).toEqual(sample(questions, config))
  expect(() => sample(questions, { ...config, perCategory: 0 })).toThrow("positive integer")
})
