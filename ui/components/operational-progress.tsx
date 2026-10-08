import type { RunDetail } from "@/lib/api"
export function OperationalProgress({ summary }: { summary: RunDetail["operational"] }) {
  const latest = summary?.attempts.at(-1)
  if (!latest) return null
  const seconds = (ms: number | null) => (ms === null ? "Unmeasured" : `${(ms / 1000).toFixed(1)}s`)
  return (
    <div className="text-sm text-text-secondary">
      <p className="font-medium">
        Operational progress · attempt {summary!.attempts.length} · {latest.outcome}
      </p>
      <p>
        {latest.acceptedSessionUploads} accepted session uploads ·{" "}
        {latest.acceptedSourceMessages.toLocaleString()} source messages ·{" "}
        {latest.failedSessionUploads} failed uploads
      </p>
      <p>
        Ingestion: {seconds(latest.ingestionWallMs)} · throughput:{" "}
        {latest.acceptedMessagesPerSecond?.toFixed(1) ?? "Unmeasured"} messages/s
      </p>
      <p>
        Readiness wait: {seconds(latest.readinessWaitMs)} · ingestion to confirmed readiness:{" "}
        {seconds(latest.ingestionToReadinessMs)}
      </p>
      <p>
        Successful session upload p95: {seconds(latest.successfulUploadLatency.p95Ms)} · failed
        upload p95: {seconds(latest.failedUploadLatency.p95Ms)}
      </p>
      <p className="text-xs mt-2">
        Session upload calls differ by provider; these are not per-turn request timings. Accepted
        input does not prove extraction success. Failed calls may have partial remote effects.
        Quality scores exclude incomplete evaluations.
      </p>
    </div>
  )
}
