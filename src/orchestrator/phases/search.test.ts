import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointManager } from "../checkpoint"
import { runSearchPhase } from "./search"
import type { Provider } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"

test("search phase requests the same native top ten without a shared score cutoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-policy-"))
  const manager = new CheckpointManager(dir)
  try {
    for (const name of ["mem0", "atlas-agent-engine"]) {
      const c = manager.create(name, name, "test", "gpt-4o", "gpt-4o")
      const q = {
        questionId: "q",
        question: "Where?",
        groundTruth: "Paris",
        questionType: "single-hop",
        haystackSessionIds: [],
      }
      manager.initQuestion(c, "q", `q-${name}`, q)
      manager.updatePhase(c, "q", "indexing", { status: "completed" })
      const b: Benchmark = {
        name: "test",
        load: async () => {},
        getQuestions: () => [q],
        getHaystackSessions: () => [],
        getGroundTruth: () => "Paris",
        getQuestionTypes: () => ({}),
      }
      const provider = {
        name,
        search: async (_query: string, options: unknown) => {
          expect(options).toEqual({ containerTag: `q-${name}`, limit: 10 })
          return [{ content: "Paris", score: 0.01 }]
        },
      } as Provider
      await runSearchPhase(provider, b, c, manager)
      expect(c.questions.q.phases.search.results).toHaveLength(1)
    }
  } finally {
    await manager.flush()
    rmSync(dir, { recursive: true, force: true })
  }
})
