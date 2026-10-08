import { readAtlasQueue } from "./queue"
import { compatibleFetch } from "./transport"
import { diagnose } from "../../utils/diagnostics"
import { logger } from "../../utils/logger"
import {
  Memory,
  MemoryAPIError,
  MemoryServerError,
  MemoryConnectionError,
  type FetchLike,
} from "@mongodb-js/agent-engine-sdk-memory"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { prompts } from "./prompts"
import { normalize, searchLimit } from "./results"
import { connectionOptions } from "./config"
import { transcriptChunks, turns } from "./content"
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
  readinessPolicy: import("../../types/provider").ReadinessPolicy = {
    method: "searchable-receipts",
    extractionCompletionConfirmed: false,
  }
  concurrency = { default: 2 }
  prompts = prompts
  protected sources = ["episodic"]
  protected memory!: Memory
  protected queueConnection!: ReturnType<typeof connectionOptions>
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
    const options = connectionOptions(config)
    this.queueConnection = options
    this.connection = digest([options.baseUrl, options.projectId, this.name, 1])
    this.memory = new Memory({ ...options, fetchImpl: compatibleFetch(this.deps.fetchImpl) })
  }

  async observeQueue() {
    return readAtlasQueue(this.queueConnection)
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
      writes: transcriptChunks(session).map((chunk, i) => ({
        key: digest([scope, session.sessionId, i, chunk]),
        content: chunk.content,
        role: "user",
        metadata: { ...chunk.metadata, chunkIndex: i },
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
      metadata: { ...entry.metadata, memorybenchKey: entry.key, sourceSessionId: session.sourceId },
    })
    if (!result.acknowledged || !result.id)
      throw new Error("Atlas did not acknowledge the episode write.")
    return result.id
  }
  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const scope = this.scope(options.containerTag)
    const context = { provider: this.name, tag: options.containerTag }
    logger.trace("[atlas ingest] Acquiring manifest lock", context)
    return this.store.lock(scope, async () => {
      logger.trace("[atlas ingest] Manifest lock acquired", context)
      const state = await diagnose("[atlas ingest] Read manifest", context, () =>
        this.store.read(scope, this.connection)
      )
      const documentIds: string[] = []
      for (const input of sessions) {
        const key = digest(input.sessionId)
        const prepared = this.prepare(input, scope)
        const session = (state.sessions[key] ??= prepared)
        if (session.fingerprint !== prepared.fingerprint)
          throw new Error("Atlas source session changed; use a new run ID.")
        const sessionStarted = Date.now()
        const sessionContext = {
          ...context,
          sessionId: input.sessionId,
          remoteSessionId: session.remoteId,
        }
        let reused = 0
        let written = 0
        logger.debug("[atlas ingest] Session started", {
          ...sessionContext,
          writes: session.writes.length,
          acknowledged: session.writes.filter((w) => w.id).length,
        })
        for (const [writeIndex, entry] of session.writes.entries()) {
          const writeContext = {
            ...sessionContext,
            write: writeIndex + 1,
            totalWrites: session.writes.length,
            contentBytes: Buffer.byteLength(entry.content),
          }
          if (!entry.id) {
            const pending = entry.pending
            entry.pending = true
            await diagnose("[atlas ingest] Save pending manifest", writeContext, () =>
              this.store.save(scope, state)
            )
            try {
              entry.id = await diagnose(
                pending
                  ? "[atlas ingest] Reconcile or replay pending write"
                  : "[atlas ingest] Remote write",
                writeContext,
                () =>
                  this.write(
                    this.memory.bind({ userId: scope, sessionId: session.remoteId }),
                    session,
                    { ...entry, pending }
                  )
              )
              entry.pending = false
              session.lastWrite = this.now()
              await diagnose("[atlas ingest] Save receipt manifest", writeContext, () =>
                this.store.save(scope, state)
              )
              written++
            } catch (error) {
              if (
                !pending &&
                error instanceof MemoryAPIError &&
                error.status !== null &&
                [400, 401, 403, 404, 413, 422, 429].includes(error.status)
              ) {
                entry.pending = false
                await this.store.save(scope, state)
              }
              throw this.failure(error)
            }
          } else {
            reused++
          }
          documentIds.push(entry.id)
        }
        logger.debug("[atlas ingest] Session completed", {
          ...sessionContext,
          written,
          reused,
          durationMs: Date.now() - sessionStarted,
        })
      }
      return { documentIds: [...new Set(documentIds)] }
    })
  }
  protected failure(error: unknown): Error {
    if (error instanceof MemoryServerError && error.status === null)
      return new Error(
        "Atlas response validation failed: the SDK could not parse the server response. Check SDK/server schema compatibility. Response body omitted."
      )
    if (error instanceof MemoryConnectionError)
      return new Error(
        "Atlas connection failed: the SDK could not complete the request. Check service connectivity and timeouts; resume with the same manifest."
      )
    if (error instanceof MemoryAPIError)
      return new Error(
        `Atlas request failed (HTTP ${error.status ?? "unknown"}). Check authentication, provisioning and server logs; resume with the same manifest. Response body omitted.`
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
    try {
      logger.debug(`[${this.name}] Awaiting readiness`, {
        tag,
        receipts: result.documentIds?.length ?? 0,
        pollMs: POLL_MS,
        timeoutMs: TIMEOUT_MS,
      })
      await this.waitForReadiness(result, tag, progress)
      logger.debug(`[${this.name}] Readiness checks passed`, { tag })
    } catch (error) {
      throw this.failure(error)
    }
  }
  protected async waitForReadiness(
    result: IngestResult,
    tag: string,
    progress?: IndexingProgressCallback
  ) {
    const scope = this.scope(tag)
    const state = await this.store.read(scope, this.connection)
    const wanted = new Set(result.documentIds)
    const writes = Object.values(state.sessions).flatMap((s) =>
      s.writes.filter((w) => w.id && wanted.has(w.id)).map((w) => ({ s, w }))
    )
    if (writes.length !== wanted.size)
      throw new Error("Atlas receipts are missing from the local manifest.")
    const expectedSession = new Map(writes.map(({ s, w }) => [w.id!, s.remoteId]))
    const complete = new Set<string>()
    const deadline = this.now() + TIMEOUT_MS
    let poll = 0
    while (complete.size < wanted.size && this.now() < deadline) {
      poll++
      let checked = 0
      const pendingAtStart = wanted.size - complete.size
      let lastLog = this.now()
      for (const { s, w } of writes) {
        if (this.now() >= deadline) break
        if (complete.has(w.id!)) continue
        logger.trace(`[${this.name}] Checking episode searchability`, {
          tag,
          episodeId: w.id,
          sessionId: s.remoteId,
        })
        const hits = await diagnose(
          `[${this.name}] Episode search`,
          { tag, episodeId: w.id, sessionId: s.remoteId, poll, checked, pendingAtStart },
          () =>
            this.memory.bind({ userId: scope }).searchEpisodes({
              query: w.content.slice(0, 512),
              sessionId: s.remoteId,
              visibility: "private",
              topK: 100,
            })
        )
        const searchable = hits.some((h) => h.id === w.id)
        logger.trace(`[${this.name}] Episode search completed`, {
          tag,
          episodeId: w.id,
          searchable,
        })
        // Every returned receipt is evidence of searchability, not only the query's target.
        // Restrict credit to receipts expected in this session and this ingest result.
        for (const hit of hits) {
          if (expectedSession.get(hit.id) === s.remoteId) complete.add(hit.id)
        }
        checked++
        // Publish during the scan, including checks that found no searchable receipt.
        progress?.({ completedIds: [...complete], failedIds: [], total: wanted.size })
        if (
          checked === 1 ||
          checked % 10 === 0 ||
          complete.size === wanted.size ||
          checked === pendingAtStart ||
          this.now() - lastLog >= POLL_MS
        ) {
          logger.debug(`[${this.name}] Indexing scan progress`, {
            tag,
            poll,
            checked,
            pendingAtStart,
            completed: complete.size,
            total: wanted.size,
            remaining: wanted.size - complete.size,
            elapsedMs: this.now() - (deadline - TIMEOUT_MS),
          })
          lastLog = this.now()
        }
      }
      logger.debug(`[${this.name}] Indexing poll`, {
        tag,
        completed: complete.size,
        total: wanted.size,
        remainingMs: Math.max(0, deadline - this.now()),
      })
      progress?.({ completedIds: [...complete], failedIds: [], total: wanted.size })
      if (complete.size < wanted.size) await this.sleep(POLL_MS)
    }
    if (complete.size < wanted.size)
      throw new Error(
        `Atlas indexing timed out: ${wanted.size - complete.size} episodes remain unsearchable. Resume this run after checking the service.`
      )
  }
  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const limit = searchLimit(options)
    if (limit === 0) return []
    const scope = this.scope(options.containerTag)
    await this.store.read(scope, this.connection)
    try {
      const hits = await this.memory
        .bind({ userId: scope })
        .search({ query, sources: this.sources, visibility: "private", topK: limit })
      return normalize(hits, options)
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

export class AtlasAgentEngineProvider extends AtlasAgentEngineDirectProvider {
  override name = "atlas-agent-engine"
  override readinessPolicy: import("../../types/provider").ReadinessPolicy = {
    method: "stability-heuristic",
    extractionCompletionConfirmed: false,
  }
  protected override sources = ["semantic", "episodic"]
  protected override prepare(session: UnifiedSession, scope: string): SessionState {
    const state = super.prepare(session, scope)
    state.writes = turns(session).map((turn, index) => ({
      ...turn,
      key: digest([scope, session.sessionId, index, turn]),
      pending: false,
    }))
    return state
  }
  protected override async write(
    memory: Memory,
    _session: SessionState,
    entry: SessionState["writes"][number]
  ) {
    const result = await memory.recordTurn({
      role: entry.role,
      content: entry.content,
      idempotencyKey: entry.key,
    })
    if (!result.acknowledged || !result.id)
      throw new Error("Atlas did not acknowledge the turn write.")
    return result.id
  }
  protected override async waitForReadiness(
    result: IngestResult,
    tag: string,
    progress?: IndexingProgressCallback
  ) {
    const scope = this.scope(tag)
    const state = await this.store.read(scope, this.connection)
    const wanted = new Set(result.documentIds)
    const sessions = Object.values(state.sessions).filter((s) =>
      s.writes.some((w) => w.id && wanted.has(w.id))
    )
    const known = new Set(sessions.flatMap((s) => s.writes.flatMap((w) => (w.id ? [w.id] : []))))
    if ([...wanted].some((id) => !known.has(id)))
      throw new Error("Atlas turn receipts are missing from the local manifest.")
    logger.debug(
      `[${this.name}] Readiness requires 180s after the last write, searchable episodes, and 60s of unchanged episodes`,
      { tag, sessions: sessions.length }
    )
    const stability = new Map<string, { fingerprint: string; since: number }>()
    type SessionStatus = "pending" | "grace" | "episodes" | "search" | "stability" | "ready"
    // Retain the latest observation between scans; rechecks can revoke readiness.
    const statuses = new Map<string, SessionStatus>(sessions.map((s) => [s.remoteId, "pending"]))
    const publish = (checkingSession?: string) => {
      const waiting = { pending: 0, grace: 0, episodes: 0, search: 0, stability: 0 }
      const completedIds: string[] = []
      let readySessions = 0
      for (const session of sessions) {
        const status = statuses.get(session.remoteId)!
        if (status === "ready") {
          readySessions++
          completedIds.push(
            ...session.writes.flatMap((w) => (w.id && wanted.has(w.id) ? [w.id] : []))
          )
        } else waiting[status]++
      }
      progress?.({
        completedIds,
        failedIds: [],
        total: wanted.size,
        readiness: {
          totalSessions: sessions.length,
          readySessions,
          waiting,
          checkingSession,
          checkedAt: new Date(this.now()).toISOString(),
        },
      })
    }
    publish()
    const deadline = this.now() + TIMEOUT_MS
    while (this.now() < deadline) {
      const completedIds: string[] = []
      const waiting = { grace: 0, episodes: 0, search: 0, stability: 0 }
      let maxGraceRemainingMs = 0
      for (const session of sessions) {
        if (this.now() >= deadline) break
        publish(session.sourceId)
        try {
          const graceRemainingMs = Math.max(0, 180000 - (this.now() - session.lastWrite))
          if (graceRemainingMs > 0) {
            statuses.set(session.remoteId, "grace")
            waiting.grace++
            maxGraceRemainingMs = Math.max(maxGraceRemainingMs, graceRemainingMs)
            logger.trace(`[${this.name}] Session waiting after last write`, {
              tag,
              sessionId: session.remoteId,
              remainingMs: graceRemainingMs,
            })
            continue
          }
          const memory = this.memory.bind({ userId: scope })
          logger.trace(`[${this.name}] Listing session episodes`, {
            tag,
            sessionId: session.remoteId,
          })
          const entries = (await memory.listEpisodes({
            sessionId: session.remoteId,
            visibility: "private",
            limit: 1000,
          })) as { id?: string; content?: string }[]
          logger.trace(`[${this.name}] Session episodes returned`, {
            tag,
            sessionId: session.remoteId,
            count: entries.length,
          })
          if (
            !entries.length ||
            entries.length >= 1000 ||
            entries.some((e) => !e.id || !e.content)
          ) {
            statuses.set(session.remoteId, "episodes")
            waiting.episodes++
            stability.delete(session.remoteId)
            continue
          }
          const fingerprint = digest(
            entries
              .map((e) => [e.id, e.content])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          )
          const previous = stability.get(session.remoteId)
          if (previous?.fingerprint !== fingerprint)
            stability.set(session.remoteId, { fingerprint, since: this.now() })
          logger.trace(`[${this.name}] Checking session searchability`, {
            tag,
            sessionId: session.remoteId,
          })
          const hits = await memory.searchEpisodes({
            query: entries[0].content!.slice(0, 512),
            sessionId: session.remoteId,
            visibility: "private",
            topK: 100,
          })
          const searchable = hits.some((h) => entries.some((e) => e.id === h.id))
          logger.trace(`[${this.name}] Session search completed`, {
            tag,
            sessionId: session.remoteId,
            searchable,
          })
          if (!searchable) {
            statuses.set(session.remoteId, "search")
            waiting.search++
            stability.delete(session.remoteId)
            continue
          }
          const stableMs = this.now() - stability.get(session.remoteId)!.since
          logger.trace(`[${this.name}] Session stability`, {
            tag,
            sessionId: session.remoteId,
            stableMs,
            requiredMs: 60000,
          })
          statuses.set(session.remoteId, stableMs >= 60000 ? "ready" : "stability")
          if (stableMs < 60000) waiting.stability++
          if (stableMs >= 60000)
            completedIds.push(
              ...session.writes.flatMap((w) => (w.id && wanted.has(w.id) ? [w.id] : []))
            )
        } finally {
          publish()
        }
      }
      logger.debug(`[${this.name}] Readiness poll`, {
        tag,
        completed: completedIds.length,
        total: wanted.size,
        waiting,
        maxGraceRemainingMs,
        remainingMs: Math.max(0, deadline - this.now()),
      })
      if (completedIds.length === wanted.size) return
      await this.sleep(POLL_MS)
    }
    throw new Error(
      "Atlas extraction readiness timed out. Every nonempty session needs an observable searchable episode; this is not an extraction-complete signal."
    )
  }
}
