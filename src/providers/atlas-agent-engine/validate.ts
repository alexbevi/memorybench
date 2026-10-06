import { randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import { AtlasAgentEngineProvider, AtlasAgentEngineDirectProvider } from "./index"
import { getProviderConfig } from "../../utils/config"
import { digest } from "./state"
import type { Provider, ProviderConfig } from "../../types/provider"

export async function validateLive(
  factory: () => Provider,
  config: ProviderConfig,
  log = console.log
) {
  const provider = factory()
  await provider.initialize(config)
  const tag = `atlas-validation-${randomUUID()}`
  const otherTag = `${tag}-other`
  log(`Validation scopes: ${tag}, ${otherTag}`)
  log(`Remote user IDs: ${digest([provider.name, tag])}, ${digest([provider.name, otherTag])}`)
  log(
    "Validation writes persistent data. Receipts remain in data/atlas-agent-engine; remote cleanup requires service administration."
  )
  const sessions = [
    {
      sessionId: "airport",
      messages: [
        {
          role: "user" as const,
          content:
            "Remember that my home airport is Boston Logan. I always start my trips in Boston.",
        },
      ],
    },
    {
      sessionId: "seat",
      messages: [
        {
          role: "user" as const,
          content:
            "Remember that I prefer a window seat on every flight. Please book a window seat for me.",
        },
      ],
    },
  ]
  const result = await provider.ingest(sessions, { containerTag: tag })
  const other = await provider.ingest(
    [
      {
        sessionId: "other",
        messages: [
          { role: "user", content: "My home airport is Sydney and I always prefer an aisle seat." },
        ],
      },
    ],
    { containerTag: otherTag }
  )
  await provider.awaitIndexing(result, tag)
  await provider.awaitIndexing(other, otherTag)
  const restarted = factory()
  await restarted.initialize(config)
  const replay = await restarted.ingest(sessions, { containerTag: tag })
  if (JSON.stringify(replay) !== JSON.stringify(result))
    throw new Error("Validation failed: resumed receipts changed.")
  const hits = await restarted.search("What is my home airport and preferred seat on flights?", {
    containerTag: tag,
    limit: 10,
  })
  const content = hits
    .map((h) => String((h as { content: string }).content))
    .join("\n")
    .toLowerCase()
  if (!content.includes("boston") || !content.includes("window"))
    throw new Error("Validation failed: retrieval did not cover both sessions.")
  if (content.includes("sydney") || content.includes("aisle"))
    throw new Error("Validation failed: another container's evidence appeared.")
  if ((await restarted.search("airport seat", { containerTag: `${tag}-empty` })).length)
    throw new Error("Validation failed: an empty container returned evidence.")
  const sources = hits.map((h) => (h as { source: string }).source)
  if (
    sources.some((source) => !["semantic", "episodic"].includes(source)) ||
    (provider.name.endsWith("-direct") && sources.some((source) => source !== "episodic"))
  )
    throw new Error("Validation failed: unexpected memory source.")
  log(
    `Passed ${provider.name}: write, readiness, resume, cross-session retrieval and container isolation.`
  )
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        provider: { type: "string", default: "atlas-agent-engine-direct" },
        live: { type: "boolean", default: false },
        help: { type: "boolean" },
      },
    })
    if (values.help) {
      console.log(
        "bun src/providers/atlas-agent-engine/validate.ts --provider atlas-agent-engine[-direct] [--live]\nWithout --live, validates configuration only. --live creates persistent remote records."
      )
    } else {
      if (!["atlas-agent-engine", "atlas-agent-engine-direct"].includes(values.provider!))
        throw new Error("Select atlas-agent-engine or atlas-agent-engine-direct.")
      const factory = () =>
        values.provider === "atlas-agent-engine"
          ? new AtlasAgentEngineProvider()
          : new AtlasAgentEngineDirectProvider()
      const config = getProviderConfig(values.provider!)
      if (values.live) await validateLive(factory, config)
      else {
        await factory().initialize(config)
        console.log(
          "Configuration valid. No service request made. Add --live to validate the service."
        )
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Atlas validation failed.")
    process.exitCode = 1
  }
}
