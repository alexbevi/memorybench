import type { RunCheckpoint } from "../types/checkpoint"
export interface OperationalAttempt {
  startedAt: string
  finishedAt?: string
  outcome: "running" | "completed" | "failed" | "stopped"
  ingestStartedAt?: string
  ingestFinishedAt?: string
  indexingStartedAt?: string
  indexingFinishedAt?: string
  readinessConfirmedAt?: string
}
export interface UploadMeasurement {
  attempt: number
  durationMs: number
  outcome: "accepted" | "failed"
  messages: number
}
function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) => {
    if (!sorted.length) return null
    const rank = (sorted.length - 1) * fraction,
      low = Math.floor(rank),
      high = Math.ceil(rank)
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
  }
  return {
    count: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  }
}
export function operationalSummary(checkpoint: RunCheckpoint, now = Date.now()) {
  const uploads = Object.values(checkpoint.questions).flatMap((q) => q.phases.ingest.uploads ?? [])
  const elapsed = (start?: string, end?: string) =>
    start ? Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start)) : null
  return {
    version: "operations-v1",
    latencyUnit: "provider session upload call",
    percentileEstimator: "linear interpolation",
    workload: checkpoint.workload,
    executionPolicy: checkpoint.executionPolicy,
    concurrency: checkpoint.concurrency,
    queue: checkpoint.queue,
    admission: checkpoint.admission,
    readinessPolicy: checkpoint.readinessPolicy,
    checkpointedSessions: Object.values(checkpoint.questions).reduce(
      (n, q) => n + new Set(q.phases.ingest.completedSessions).size,
      0
    ),
    attempts: (checkpoint.operationalAttempts ?? []).map((attempt, index) => {
      const samples = uploads.filter((s) => s.attempt === index)
      const accepted = samples.filter((s) => s.outcome === "accepted"),
        failed = samples.filter((s) => s.outcome === "failed")
      const ingestionWallMs = elapsed(
        attempt.ingestStartedAt,
        attempt.ingestFinishedAt ?? attempt.finishedAt
      )
      const messages = accepted.reduce((n, s) => n + s.messages, 0)
      return {
        ...attempt,
        elapsedMs: elapsed(attempt.startedAt, attempt.finishedAt),
        acceptedSessionUploads: accepted.length,
        acceptedSourceMessages: messages,
        failedSessionUploads: failed.length,
        ingestionWallMs,
        acceptedMessagesPerSecond:
          ingestionWallMs && ingestionWallMs > 0 ? messages / (ingestionWallMs / 1000) : null,
        readinessWaitMs: elapsed(
          attempt.indexingStartedAt,
          attempt.indexingFinishedAt ?? attempt.finishedAt
        ),
        ingestionToReadinessMs:
          attempt.readinessConfirmedAt && attempt.ingestStartedAt
            ? elapsed(attempt.ingestStartedAt, attempt.readinessConfirmedAt)
            : null,
        successfulUploadLatency: latency(accepted.map((s) => s.durationMs)),
        failedUploadLatency: latency(failed.map((s) => s.durationMs)),
      }
    }),
  }
}
