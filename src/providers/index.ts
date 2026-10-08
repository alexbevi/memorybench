import type { Provider, ProviderName } from "../types/provider"
import type { ConcurrencyConfig } from "../types/concurrency"
import { SupermemoryProvider } from "./supermemory"
import { Mem0Provider } from "./mem0"
import { Mem0LocalProvider } from "./mem0-local"
import { ZepProvider } from "./zep"
import { FilesystemProvider } from "./filesystem"
import { RAGProvider } from "./rag"

import { AtlasAgentEngineProvider, AtlasAgentEngineDirectProvider } from "./atlas-agent-engine"

const providers: Record<ProviderName, new () => Provider> = {
  supermemory: SupermemoryProvider,
  mem0: Mem0Provider,
  "mem0-local": Mem0LocalProvider,
  zep: ZepProvider,
  filesystem: FilesystemProvider,
  rag: RAGProvider,
  "atlas-agent-engine": AtlasAgentEngineProvider,
  "atlas-agent-engine-direct": AtlasAgentEngineDirectProvider,
}

export function createProvider(name: ProviderName): Provider {
  const ProviderClass = providers[name]
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`)
  }
  return new ProviderClass()
}

export function getAvailableProviders(): ProviderName[] {
  return Object.keys(providers) as ProviderName[]
}

export function getProviderInfo(name: ProviderName): {
  name: string
  displayName: string
  concurrency: ConcurrencyConfig | null
} {
  const provider = createProvider(name)
  return {
    name,
    displayName:
      name === "atlas-agent-engine"
        ? "Atlas Agent Engine"
        : name === "atlas-agent-engine-direct"
          ? "Atlas Agent Engine Direct"
          : name.charAt(0).toUpperCase() + name.slice(1),
    concurrency: provider.concurrency || null,
  }
}

export { SupermemoryProvider, Mem0Provider, ZepProvider, FilesystemProvider, RAGProvider }
