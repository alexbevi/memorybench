import { test, expect } from "bun:test"
import { scoreRetrievedResults } from "./retrieval-eval"
test("retrieved relevance does not invent corpus recall or F1", () => {
  const result = scoreRetrievedResults([0, 1, 0, 1])
  expect(result.hitAtK).toBe(1)
  expect(result.precisionAtK).toBe(0.5)
  expect(result.mrr).toBe(0.5)
  expect(result).not.toHaveProperty("recallAtK")
  expect(result).not.toHaveProperty("f1AtK")
  expect(scoreRetrievedResults([]).hitAtK).toBe(0)
})
