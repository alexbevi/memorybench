import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { sourceMessages } from "../../utils/source-message"
import { logger } from "../../utils/logger"

type Transport = (url: URL, init: RequestInit) => Promise<Response>
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** REST contract of the standalone server pinned in self-hosted/mem0. */
export class Mem0LocalProvider implements Provider {
  name = "mem0-local"
  concurrency = { default: 2 }
  // The OSS library can swallow extraction errors. HTTP completion is not proof
  // that every fact was extracted or that every requested memory action succeeded.
  readinessPolicy = {
    method: "synchronous-response" as const,
    extractionCompletionConfirmed: false,
  }
  private baseUrl?: URL
  private apiKey = ""
  private timeoutMs = 300_000

  constructor(private transport: Transport = (url, init) => fetch(url, init)) {}

  async initialize(config: ProviderConfig): Promise<void> {
    const url = new URL(config.baseUrl ?? "http://localhost:8888")
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Mem0 local URL must be HTTP(S), without credentials, query, or fragment")
    }
    if (!url.pathname.endsWith("/")) url.pathname += "/"
    const timeout = config.timeoutMs ?? 300_000
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error("Mem0 local timeoutMs must be a positive integer")
    }
    this.baseUrl = url
    this.apiKey = config.apiKey
    this.timeoutMs = timeout
  }

  private scope(tag: string): void {
    if (!tag.trim()) throw new Error("Mem0 local requires a nonempty container tag")
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    if (!this.baseUrl) throw new Error("Initialize Mem0 local provider first")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.transport(new URL(path, this.baseUrl), {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { "X-API-Key": this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      })
      if (!response.ok) {
        // Server error bodies can contain source text or upstream credentials.
        throw new Error(`Mem0 local ${method} failed with HTTP ${response.status}`)
      }
      try {
        return await response.json()
      } catch {
        throw new Error("Mem0 local returned invalid JSON")
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          "Mem0 local request timed out; a write may have completed. Inspect the namespace before resuming"
        )
      }
      if (error instanceof Error && error.message.startsWith("Mem0 local")) throw error
      throw new Error(
        "Mem0 local request failed; a write may have completed. Inspect the namespace before resuming"
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private results(response: unknown): RecordValue[] {
    if (!record(response) || !Array.isArray(response.results) || !response.results.every(record)) {
      throw new Error("Mem0 local returned an invalid results envelope")
    }
    return response.results
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    this.scope(options.containerTag)
    const ids = new Set<string>()
    for (const session of sessions) {
      const messages = sourceMessages(session)
      if (!messages.length) continue
      const results = this.results(
        await this.request("memories", "POST", {
          messages,
          user_id: options.containerTag,
          infer: true,
          metadata: {
            ...session.metadata,
            ...options.metadata,
            sessionId: session.sessionId,
            timestamp: session.metadata?.date,
          },
        })
      )
      for (const result of results) {
        if (
          typeof result.id !== "string" ||
          !result.id ||
          !["ADD", "UPDATE", "DELETE", "NONE"].includes(String(result.event))
        ) {
          throw new Error("Mem0 local returned an invalid memory operation")
        }
        if (result.event === "DELETE") ids.delete(result.id)
        else ids.add(result.id)
      }
      if (!results.length)
        logger.warn(
          `Mem0 local returned no memory operations for ${session.sessionId}; this does not confirm successful extraction`
        )
    }
    return { documentIds: [...ids] }
  }

  async awaitIndexing(result: IngestResult, tag: string, progress?: IndexingProgressCallback) {
    this.scope(tag)
    // IDs acknowledge synchronous operations, not independent searchability checks.
    progress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    this.scope(options.containerTag)
    const limit = options.limit ?? 10
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Mem0 local limit must be a nonnegative integer")
    if (!limit) return []
    const results = this.results(
      await this.request("search", "POST", {
        query,
        user_id: options.containerTag,
        limit,
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      })
    )
    if (results.some((r) => typeof r.id !== "string" || !r.id || typeof r.memory !== "string")) {
      throw new Error("Mem0 local returned an invalid search memory")
    }
    // Graph relations use a different shape and ranking; don't mix them into evidence.
    return results.slice(0, limit)
  }

  async clear(containerTag: string): Promise<void> {
    this.scope(containerTag)
    await this.request(`memories?${new URLSearchParams({ user_id: containerTag })}`, "DELETE")
  }
}
