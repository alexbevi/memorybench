import { Memory, MemoryAPIError, type FetchLike } from "@mongodb-js/agent-engine-sdk-memory"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { chunks, turns } from "./content"
import { digest, Store, type SessionState } from "./state"

export const POLL_MS = 5000
export const TIMEOUT_MS = 900000
export interface Dependencies {
  stateDir?: string
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class AtlasAgentEngineDirectProvider implements Provider {
  name = "atlas-agent-engine-direct"
  concurrency = { default: 2 }
  protected memory!: Memory
  protected connection!: string
  protected store: Store
  protected now: () => number
  protected sleep: (ms: number) => Promise<void>
  constructor(protected deps: Dependencies = {}) {
    this.store = new Store(deps.stateDir ?? "data/atlas-agent-engine")
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }
  async initialize(config: ProviderConfig) {
    if (
      !config.baseUrl ||
      config.apiKey ||
      config.projectId ||
      process.env.AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN ||
      process.env.AGENTIC_MEMORY_API_KEY ||
      process.env.AGENTIC_MEMORY_PROJECT_ID
    )
      throw new Error("Local Atlas requires AGENTIC_MEMORY_BASE_URL and no token or project ID.")
    const url = new URL(config.baseUrl)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Atlas base URL must be an HTTP(S) URL without credentials, query, or fragment."
      )
    this.connection = digest([url.href, "", this.name, 1])
    this.memory = new Memory({
      baseUrl: url.href.replace(/\/$/, ""),
      projectId: "",
      fetchImpl: this.deps.fetchImpl,
    })
  }
  protected scope(tag: string) {
    if (!this.memory) throw new Error("Initialize Atlas provider first.")
    return digest([this.name, tag])
  }
  protected prepare(session: UnifiedSession, scope: string): SessionState {
    return {
      sourceId: session.sessionId,
      fingerprint: digest(session),
      remoteId: digest([scope, session.sessionId]),
      lastWrite: 0,
      writes: chunks(
        turns(session)
          .map((m) => m.content)
          .join("\n\n")
      ).map((chunk, i) => ({
        key: digest([scope, session.sessionId, i, chunk]),
        content: chunk.content,
        role: "user",
        pending: false,
      })),
    }
  }
  protected async write(
    memory: Memory,
    session: SessionState,
    entry: SessionState["writes"][number]
  ) {
    if (entry.pending) {
      const episodes = await memory.listEpisodes({
        sessionId: session.remoteId,
        visibility: "private",
        limit: 1000,
      })
      const matches = episodes.filter((e: any) => e.metadata?.memorybenchKey === entry.key) as {
        id: string
      }[]
      if (episodes.length >= 1000 || matches.length !== 1 || !matches[0].id)
        throw new Error(
          "Uncertain Atlas episode write cannot be reconciled. Retain the manifest; inspect the service or use a fresh run ID."
        )
      return matches[0].id
    }
    const result = await memory.saveEpisode({
      title: `MemoryBench ${session.sourceId}`,
      content: entry.content,
      sessionId: session.remoteId,
      visibility: "private",
      metadata: { memorybenchKey: entry.key, sourceSessionId: session.sourceId },
    })
    if (!result.acknowledged || !result.id)
      throw new Error("Atlas did not acknowledge the episode write.")
    return result.id
  }
  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const scope = this.scope(options.containerTag)
    return this.store.lock(scope, async () => {
      const state = await this.store.read(scope, this.connection)
      const documentIds: string[] = []
      for (const input of sessions) {
        const key = digest(input.sessionId)
        const prepared = this.prepare(input, scope)
        const session = (state.sessions[key] ??= prepared)
        if (session.fingerprint !== prepared.fingerprint)
          throw new Error("Atlas source session changed; use a new run ID.")
        for (const entry of session.writes) {
          if (!entry.id) {
            const pending = entry.pending
            entry.pending = true
            await this.store.save(scope, state)
            try {
              entry.id = await this.write(
                this.memory.bind({ userId: scope, sessionId: session.remoteId }),
                session,
                { ...entry, pending }
              )
              entry.pending = false
              session.lastWrite = this.now()
              await this.store.save(scope, state)
            } catch (error) {
              if (
                error instanceof MemoryAPIError &&
                error.status &&
                error.status >= 400 &&
                error.status < 500
              ) {
                entry.pending = false
                await this.store.save(scope, state)
              }
              throw this.failure(error)
            }
          }
          documentIds.push(entry.id)
        }
      }
      return { documentIds: [...new Set(documentIds)] }
    })
  }
  protected failure(error: unknown): Error {
    if (error instanceof MemoryAPIError)
      return new Error(
        `Atlas request failed (HTTP ${error.status ?? "network"}). Check authentication, provisioning and server logs; resume with the same manifest. Response body omitted.`
      )
    if (
      (error instanceof Error && error.message.startsWith("Atlas")) ||
      (error instanceof Error && error.message.startsWith("Uncertain Atlas"))
    )
      return error as Error
    return new Error(
      "Atlas SDK operation failed. Check service connectivity and SDK compatibility; retain the manifest before resuming."
    )
  }
  async awaitIndexing(result: IngestResult, tag: string, progress?: IndexingProgressCallback) {
    const scope = this.scope(tag)
    const state = await this.store.read(scope, this.connection)
    const wanted = new Set(result.documentIds)
    const writes = Object.values(state.sessions).flatMap((s) =>
      s.writes.filter((w) => w.id && wanted.has(w.id)).map((w) => ({ s, w }))
    )
    if (writes.length !== wanted.size)
      throw new Error("Atlas receipts are missing from the local manifest.")
    const complete = new Set<string>()
    const deadline = this.now() + TIMEOUT_MS
    while (complete.size < wanted.size && this.now() < deadline) {
      for (const { s, w } of writes) {
        if (complete.has(w.id!)) continue
        const hits = await this.memory
          .bind({ userId: scope })
          .searchEpisodes({
            query: w.content.slice(0, 512),
            sessionId: s.remoteId,
            visibility: "private",
            topK: 100,
          })
        if (hits.some((h) => h.id === w.id)) complete.add(w.id!)
      }
      progress?.({ completedIds: [...complete], failedIds: [], total: wanted.size })
      if (complete.size < wanted.size) await this.sleep(POLL_MS)
    }
    if (complete.size < wanted.size)
      throw new Error(
        `Atlas indexing timed out: ${wanted.size - complete.size} episodes remain unsearchable. Resume this run after checking the service.`
      )
  }
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const scope = this.scope(options.containerTag)
    await this.store.read(scope, this.connection)
    try {
      return await this.memory
        .bind({ userId: scope })
        .search({ query, sources: ["episodic"], visibility: "private", topK: options.limit ?? 10 })
    } catch (error) {
      throw this.failure(error)
    }
  }
  async clear(_containerTag: string): Promise<void> {
    throw new Error(
      "Atlas full-scope deletion is unsupported by the public JavaScript SDK. Remove remote data through service administration; a new run ID does not delete old data."
    )
  }
}
