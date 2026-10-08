import { expect, test } from "bun:test"
import { estimateWorkload } from "./workload"
import type { Benchmark } from "../types/benchmark"
import { AtlasAgentEngineProvider } from "../providers/atlas-agent-engine"
const sessions = [
  {
    sessionId: "history",
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ],
  },
]
const benchmark = { getHaystackSessions: () => sessions } as unknown as Benchmark

test("workload uses generic histories and does not depend on concurrency or optional provider estimates", () => {
  const result = estimateWorkload(benchmark, ["a", "b"], {})
  expect(result).toEqual({
    questions: 2,
    distinctHistories: 1,
    repeatedHistories: 1,
    sessions: 2,
    messages: 4,
    reusePolicy: "per-question",
  })
  const custom = estimateWorkload(benchmark, ["a", "b"], {
    estimateWrites: (s) => ({ count: s.length, unit: "session requests" }),
  })
  expect(custom.writes).toEqual({ count: 2, unit: "session requests" })
  expect(estimateWorkload(benchmark, ["a", "b"], new AtlasAgentEngineProvider()).writes).toEqual({
    count: 4,
    unit: "turn writes",
  })
  expect(estimateWorkload(benchmark, [], {}).questions).toBe(0)
})
