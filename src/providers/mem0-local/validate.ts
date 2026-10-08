/** Live smoke test. Writes only generated namespaces and clears them afterward. */
import { randomUUID } from "node:crypto"
import { Mem0LocalProvider } from "./index"
import { getProviderConfig } from "../../utils/config"
import type { UnifiedSession } from "../../types/unified"

const config = getProviderConfig("mem0-local")
const provider = new Mem0LocalProvider()
await provider.initialize(config)
const prefix = `memorybench-mem0-local-smoke-${randomUUID()}`
const scopeA = `${prefix}-a`
const scopeB = `${prefix}-b`
const session = (id: string, speaker: string, content: string): UnifiedSession => ({
  sessionId: id,
  metadata: { date: "2023-05-08T13:56:00.000Z" },
  messages: [{ role: "user", speaker, content }],
})
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

console.log(`Mem0 local live validation: ${prefix}`)
console.log("Writes three small sessions; incurs extraction and embedding calls.")
try {
  const result = await provider.ingest(
    [
      session("home", "Alex", "My name is Alex. I live in Halifax."),
      session("hobby", "Alex", "My name is Alex. My favorite hobby is sailing."),
    ],
    { containerTag: scopeA }
  )
  assert(result.documentIds.length > 0, "No memories extracted from the validation facts")
  await provider.awaitIndexing(result, scopeA)
  await provider.ingest([session("home", "Jordan", "My name is Jordan. I live in Quito.")], {
    containerTag: scopeB,
  })

  // A new adapter instance must find both sessions without local transient state.
  const resumed = new Mem0LocalProvider()
  await resumed.initialize(config)
  const home = JSON.stringify(
    await resumed.search("Where does Alex live?", { containerTag: scopeA })
  )
  const hobby = JSON.stringify(
    await resumed.search("What is Alex's favorite hobby?", { containerTag: scopeA })
  )
  const other = JSON.stringify(
    await resumed.search("Where does Jordan live?", { containerTag: scopeB })
  )
  assert(/Halifax/i.test(home), "Expected Halifax in first namespace")
  assert(/sailing/i.test(hobby), "Expected sailing from second session")
  assert(/Quito/i.test(other), "Expected Quito in second namespace")
  assert(!/Quito/i.test(home + hobby), "Second namespace leaked into first")
  assert(!/Halifax|sailing/i.test(other), "First namespace leaked into second")

  await provider.clear(scopeA)
  assert(
    (await resumed.search("Alex", { containerTag: scopeA })).length === 0,
    "Scoped clear left memories behind"
  )
  const preserved = await resumed.search("Jordan", { containerTag: scopeB })
  assert(JSON.stringify(preserved).includes("Quito"), "Clearing first namespace affected second")
  console.log(
    "PASS: ingestion, cross-session search, adapter restart, namespace isolation, and scoped deletion"
  )
} finally {
  const cleanup = await Promise.allSettled([provider.clear(scopeA), provider.clear(scopeB)])
  if (cleanup.some((result) => result.status === "rejected")) {
    throw new Error(`Cleanup failed; inspect only the smoke namespaces ${scopeA} and ${scopeB}`)
  }
  console.log("Temporary namespaces cleared")
}
