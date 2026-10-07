import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { expect, test } from "bun:test"
import { LoCoMoBenchmark } from "../../benchmarks/locomo"
import { Mem0Provider } from "./index"
import { turns, transcriptChunks } from "../atlas-agent-engine/content"

test("LoCoMo sends both human speakers, source dates and sessions to Mem0 and Atlas", async () => {
  const benchmark = new LoCoMoBenchmark()
  const directory = await mkdtemp(join(tmpdir(), "locomo-parity-"))
  const path = join(directory, "fixture.json")
  try {
    await writeFile(
      path,
      JSON.stringify([
        {
          sample_id: "conversation",
          qa: [{ question: "Where does Bob live?", answer: "Paris", category: 1, evidence: [] }],
          conversation: {
            speaker_a: "Alice",
            speaker_b: "Bob",
            session_1_date_time: "1:56 pm on 8 May, 2023",
            session_1: [
              { speaker: "Alice", text: "I live in London.", dia_id: "1" },
              { speaker: "Bob", text: "I live in Paris.", dia_id: "2" },
            ],
          },
        },
      ])
    )
    await benchmark.load({ dataPath: relative(process.cwd(), path) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const sessions = benchmark.getHaystackSessions(benchmark.getQuestions()[0].questionId)
  const received: any[] = []
  const provider = new Mem0Provider()
  // Replace only the transport: exercise the real provider ingest path without API calls.
  ;(provider as any).client = {
    add: async (messages: unknown, options: unknown) => {
      received.push({ messages, options })
      return [{ event_id: String(received.length) }]
    },
  }
  await provider.ingest(sessions, { containerTag: "parity-test" })
  expect(received).toHaveLength(sessions.length)
  const speakers = new Set<string>()
  for (const [index, session] of sessions.entries()) {
    expect(received[index].messages).toEqual(turns(session))
    const chunks = transcriptChunks(session)
    for (const [messageIndex, message] of session.messages.entries()) {
      expect(message.role).toBe("user")
      speakers.add(message.speaker!)
      const sent = received[index].messages[messageIndex]
      expect(sent.content).toContain(message.content)
      expect(sent.content).toContain(`Speaker: ${message.speaker}`)
      expect(sent.content).toContain(`Source date: ${session.metadata!.date}`)
      expect(sent.content).toContain(`Source session: ${session.sessionId}`)
      for (const chunk of chunks.filter((c) => c.metadata.messageIndex === messageIndex)) {
        expect(chunk.content).toContain(`Speaker: ${message.speaker}`)
        expect(chunk.content).toContain(`Source date: ${session.metadata!.date}`)
      }
    }
  }
  expect(speakers.size).toBe(2)
})
