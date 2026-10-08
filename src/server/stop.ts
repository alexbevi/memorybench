import { isRunActive, requestStop } from "./runState"

// No installed provider adapter exposes cancellation of accepted remote jobs.
export const cancellationCapabilities = {
  local: true,
  remote: false,
} as const

export function stopLocalRun(runId: string, input: unknown = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { status: 400, body: { error: "Expected a stop request object" } }
  }
  const scope = (input as { scope?: unknown }).scope ?? "local"
  if (scope === "remote" || scope === "all") {
    return {
      status: 409,
      body: {
        error:
          "Remote extraction cancellation is unsupported. Request scope 'local' to stop benchmark work only. No stop was requested.",
        cancellationCapabilities,
      },
    }
  }
  if (scope !== "local") {
    return { status: 400, body: { error: "Unknown cancellation scope" } }
  }
  if (!isRunActive(runId)) {
    return { status: 404, body: { error: "Run is not active" } }
  }
  requestStop(runId)
  return {
    status: 200,
    body: {
      message:
        "Local stop requested. In-flight requests may finish; accepted remote extraction jobs are not cancelled.",
      runId,
      scope: "local",
      remoteCancellation: "not-requested",
      cancellationCapabilities,
    },
  }
}
