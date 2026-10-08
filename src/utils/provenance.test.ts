import { test, expect } from "bun:test"
import { datasetHash, publicProviderConfig, captureProvenance } from "./provenance"
import type { Benchmark } from "../types/benchmark"
const benchmark: Benchmark = {
  name: "test",
  load: async () => {},
  getQuestions: () => [
    {
      questionId: "q",
      question: "Where?",
      questionType: "single-hop",
      groundTruth: "Paris",
      haystackSessionIds: ["s"],
    },
  ],
  getHaystackSessions: () => [{ sessionId: "s", messages: [{ role: "user", content: "Paris" }] }],
  getGroundTruth: () => "Paris",
  getQuestionTypes: () => ({}),
}
test("dataset digest changes with source evidence and excludes credentials", () => {
  expect(datasetHash(benchmark)).toBe(datasetHash(benchmark))
  expect(datasetHash({ ...benchmark, getHaystackSessions: () => [] })).not.toBe(
    datasetHash(benchmark)
  )
  const config = {
    apiKey: "secret",
    baseUrl: "https://user:password@example.com/path?token=secret",
    arbitrarySecret: "private",
  }
  expect(publicProviderConfig(config)).toEqual({
    endpoint: "https://example.com",
    projectId: undefined,
  })
  const captured = captureProvenance(benchmark, ["q"], config)
  expect(JSON.stringify(captured)).not.toContain("secret")
  expect(JSON.stringify(captured)).not.toContain("password")
  expect(captured.selectedQuestionIds).toEqual(["q"])
  expect(captured.code.sourceHash).not.toBe("unavailable")
})
