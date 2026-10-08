import { expect, test } from "bun:test"
import { assertNoFailedReceipts } from "./indexing"
import { Mem0Provider } from "../../providers/mem0"
import { AtlasAgentEngineProvider } from "../../providers/atlas-agent-engine"
test("failed receipts cannot silently pass indexing", () => {
  expect(() => assertNoFailedReceipts({ completedIds: ["a"], failedIds: ["b"], total: 2 })).toThrow(
    "incomplete data"
  )
  expect(() =>
    assertNoFailedReceipts({ completedIds: ["a"], failedIds: [], total: 1 })
  ).not.toThrow()
})
test("readiness distinguishes provider jobs from inferred stability", () => {
  expect(new Mem0Provider().readinessPolicy).toEqual({
    method: "job-completion",
    extractionCompletionConfirmed: true,
  })
  expect(new AtlasAgentEngineProvider().readinessPolicy).toEqual({
    method: "stability-heuristic",
    extractionCompletionConfirmed: false,
  })
})
