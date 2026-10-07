import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointManager } from "../checkpoint"
import { runAnswerPhase } from "./answer"
import type { Benchmark } from "../../types/benchmark"
import type { Provider } from "../../types/provider"

test("answer phase ignores provider prompt overrides and persists the shared generation policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "answer-parity-"))
  const manager = new CheckpointManager(directory)
  const requests: any[] = []
  try {
    const question = {
      questionId: "q",
      question: "Where?",
      groundTruth: "Paris",
      questionType: "single",
      haystackSessionIds: [],
    }
    const benchmark: Benchmark = {
      name: "test",
      load: async () => {},
      getQuestions: () => [question],
      getHaystackSessions: () => [],
      getGroundTruth: () => "Paris",
      getQuestionTypes: () => ({}),
    }
    const resultFile = join(directory, "results.json")
    writeFileSync(resultFile, JSON.stringify({ results: [{ content: "Alice lives in Paris." }] }))
    for (const name of ["mem0", "atlas-agent-engine"]) {
      const checkpoint = manager.create(name, name, "test", "gpt-4o", "gpt-4o")
      manager.initQuestion(checkpoint, "q", `q-${name}`, question)
      manager.updatePhase(checkpoint, "q", "search", { status: "completed", resultFile })
      const provider: Provider = {
        name,
        prompts: {
          answerPrompt: () => {
            throw new Error("Provider-specific answer prompt must not run")
          },
        },
        initialize: async () => {},
        clear: async () => {},
        ingest: async () => ({ documentIds: [] }),
        search: async () => [],
        awaitIndexing: async () => {},
      }
      await runAnswerPhase(benchmark, checkpoint, manager, undefined, provider, async (request) => {
        requests.push(request)
        return { text: "Paris" }
      })
      await manager.flush()
      const saved = manager.load(name)!.questions.q.phases.answer
      expect(saved.answerPolicy).toMatchObject({
        version: "shared-v1",
        model: "gpt-4o",
        temperature: 0,
        maxOutputTokens: 1000,
        contextTokenBudget: 8000,
        includedResults: 1,
      })
      expect(saved.hypothesis).toBe("Paris")
    }
    expect(requests[0].prompt).toBe(requests[1].prompt)
    for (const request of requests) {
      expect(request.temperature).toBe(0)
      expect(request.maxOutputTokens).toBe(1000)
      expect(request.maxTokens).toBeUndefined()
    }
  } finally {
    await manager.flush()
    rmSync(directory, { recursive: true, force: true })
  }
})
