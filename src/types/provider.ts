import type { UnifiedSession } from "./unified"
import type { ProviderPrompts } from "./prompts"
import type { ConcurrencyConfig } from "./concurrency"

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  [key: string]: unknown
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  containerTag: string
  limit?: number
  threshold?: number
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
}

export interface ReadinessDetails {
  totalSessions: number
  readySessions: number
  waiting: Record<"pending" | "grace" | "episodes" | "search" | "stability", number>
  checkingSession?: string
  checkedAt: string
}

export interface IndexingProgress {
  readiness?: ReadinessDetails
  completedIds: string[]
  failedIds: string[]
  total: number
}

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface ReadinessPolicy {
  method: "job-completion" | "searchable-receipts" | "stability-heuristic" | "synchronous-response"
  extractionCompletionConfirmed: boolean
}

export interface Provider {
  observeQueue?(): Promise<QueueObservation>
  readinessPolicy?: ReadinessPolicy
  name: string
  prompts?: ProviderPrompts
  concurrency?: ConcurrencyConfig
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}

export type ProviderName =
  | "supermemory"
  | "mem0"
  | "mem0-local"
  | "zep"
  | "filesystem"
  | "rag"
  | "atlas-agent-engine-direct"
  | "atlas-agent-engine"

export type QueueObservation = { scope: "service"; checkedAt: string } & (
  | { status: "available"; queued: number; running: number; failed: number }
  | { status: "unsupported" | "unavailable"; reason?: string }
)
