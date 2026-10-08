import { sourceMessages } from "../../utils/source-message"
import { webcrypto } from "crypto"
if (typeof window === "undefined") {
  ;(globalThis as unknown as { window: { crypto: Crypto } }).window = {
    crypto: webcrypto as Crypto,
  }
}
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto
}

import MemoryClient, { type MemoryOptions, type SearchOptions as Mem0SearchOptions } from "mem0ai"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { MEM0_PROMPTS } from "./prompts"

import CUSTOM_INSTRUCTIONS from "./extraction-instructions.json"

export class Mem0Provider implements Provider {
  name = "mem0"
  readinessPolicy = { method: "job-completion" as const, extractionCompletionConfirmed: true }
  prompts = MEM0_PROMPTS
  concurrency = {
    default: 50,
  }
  private client: MemoryClient | null = null
  private apiKey: string = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    this.client = new MemoryClient({ apiKey: config.apiKey })

    try {
      await this.client.updateProject({
        custom_instructions: CUSTOM_INSTRUCTIONS,
      })
    } catch (e) {
      logger.warn(`Could not set custom instructions: ${e}`)
    }

    logger.info(`Initialized Mem0 provider`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.client) throw new Error("Provider not initialized")

    const eventIds: string[] = []

    for (const session of sessions) {
      const messages = sourceMessages(session)

      const addOptions: MemoryOptions = {
        user_id: options.containerTag,
        version: "v2",
        enable_graph: false,
        async_mode: true,
        metadata: {
          sessionId: session.sessionId,
          timestamp: session.metadata?.date,
          ...session.metadata,
          ...options.metadata,
        },
      }

      const result = (await this.client.add(messages, addOptions)) as Array<{
        event_id?: string
      }>
      for (const event of result) {
        if (event.event_id) eventIds.push(event.event_id)
      }
    }
    return { documentIds: eventIds }
  }

  private async getEventStatus(eventId: string): Promise<string> {
    const response = await fetch(`https://api.mem0.ai/v1/event/${eventId}/`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    })
    if (!response.ok) return "UNKNOWN"
    const data = await response.json()
    return data.status || "UNKNOWN"
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const eventIds = result.documentIds || []
    if (eventIds.length === 0) {
      onProgress?.({ completedIds: [], failedIds: [], total: 0 })
      return
    }

    const total = eventIds.length
    const pending = new Set(eventIds)
    const completedIds: string[] = []
    const failedIds: string[] = []
    let backoffMs = 500

    onProgress?.({ completedIds: [], failedIds: [], total })

    while (pending.size > 0) {
      const pendingArray = Array.from(pending)
      const results = await Promise.allSettled(
        pendingArray.map(async (eventId) => {
          const status = await this.getEventStatus(eventId)
          return { eventId, status }
        })
      )

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { eventId, status } = res.value
          if (status === "SUCCEEDED") {
            pending.delete(eventId)
            completedIds.push(eventId)
          } else if (status === "FAILED") {
            pending.delete(eventId)
            failedIds.push(eventId)
          }
        }
      }

      onProgress?.({ completedIds: [...completedIds], failedIds: [...failedIds], total })

      if (pending.size > 0) {
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 1.5, 5000)
      }
    }

    if (failedIds.length > 0) {
      throw new Error(
        `${failedIds.length} Mem0 ingestion events failed; incomplete extraction cannot be evaluated`
      )
    }
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.client) throw new Error("Provider not initialized")

    const searchOptions: Mem0SearchOptions = {
      user_id: options.containerTag,
      top_k: options.limit || 30,
      enable_graph: false,
      output_format: "v1.1",
    }

    const response = await this.client.search(query, searchOptions)

    const res = response as { results?: unknown[] }
    return res.results ?? []
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.client) throw new Error("Provider not initialized")
    await this.client.deleteAll({ user_id: containerTag })
    logger.info(`Cleared memories for user: ${containerTag}`)
  }
}

export default Mem0Provider
