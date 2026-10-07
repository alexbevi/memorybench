import { expect, test } from "bun:test"
import { prepareAnswer, ANSWER_CONTEXT_TOKENS } from "./answer"
import { getModelConfig } from "../utils/models"

const model = getModelConfig("gpt-4o")

test("shared answering keeps source evidence and omits embedding vectors", () => {
  const context = [
    { memory: "Alice lives in Paris.", metadata: { date: "2024-01-01" }, embedding: [123456789] },
  ]
  const answer = prepareAnswer("Where?", context, model, "2024-02-01")
  expect(answer.prompt).toContain("Alice lives in Paris.")
  expect(answer.prompt).toContain("2024-01-01")
  expect(answer.prompt).toContain("2024-02-01")
  expect(answer.prompt).not.toContain("123456789")
  expect(answer.policy.includedResults).toBe(1)
  expect(answer.policy.contextTruncated).toBe(false)
  expect(answer.settings).toEqual({ temperature: 0, maxOutputTokens: 1000 })
  expect(context[0].embedding).toEqual([123456789])
})

test("oversized evidence uses a bounded ranked prefix without skipping ahead", () => {
  const answer = prepareAnswer(
    "Where?",
    [
      { content: "first result" },
      { content: "🙂 source evidence ".repeat(12000) },
      { content: "LATER_RESULT_MUST_NOT_APPEAR" },
    ],
    model
  )
  expect(answer.contextTokens).toBeLessThanOrEqual(ANSWER_CONTEXT_TOKENS)
  expect(answer.prompt).toContain("first result")
  expect(answer.prompt).toContain("[truncated]")
  expect(answer.prompt).not.toContain("LATER_RESULT_MUST_NOT_APPEAR")
  expect(answer.prompt).not.toContain("�")
  expect(answer.policy).toMatchObject({
    retrievedResults: 3,
    includedResults: 2,
    contextTruncated: true,
  })
})

test("empty evidence and reasoning models use the same policy without unsupported temperature", () => {
  const answer = prepareAnswer("Where?", [], getModelConfig("gpt-5"))
  expect(answer.contextTokens).toBe(0)
  expect(answer.prompt).toContain('say "I don\'t know"')
  expect(answer.settings).toEqual({ maxOutputTokens: 1000 })
  expect(answer.policy.includedResults).toBe(0)
  expect(answer.policy.contextTruncated).toBe(false)
})
