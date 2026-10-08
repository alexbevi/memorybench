import type { QueueObservation } from "../../types/provider"
import type { connectionOptions } from "./config"

export async function readAtlasQueue(
  connection: ReturnType<typeof connectionOptions>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<QueueObservation> {
  const checkedAt = new Date().toISOString()
  const path = connection.projectId
    ? `/api/v1/projects/${encodeURIComponent(connection.projectId)}/memory/queueStats`
    : "/api/v1/memory/worker/queueStats"
  try {
    const response = await fetchImpl(connection.baseUrl + path, {
      headers: connection.serviceAccountToken
        ? { Authorization: `Bearer ${connection.serviceAccountToken}` }
        : {},
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    })
    if ([404, 405, 501].includes(response.status))
      return { status: "unsupported", scope: "service", checkedAt }
    if (!response.ok)
      return {
        status: "unavailable",
        scope: "service",
        checkedAt,
        reason: `HTTP ${response.status}`,
      }
    const data = await response.json()
    if (
      ![data?.queued, data?.running, data?.failed].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error("Invalid counts")
    return {
      status: "available",
      scope: "service",
      checkedAt,
      queued: data.queued,
      running: data.running,
      failed: data.failed,
    }
  } catch {
    return {
      status: "unavailable",
      scope: "service",
      checkedAt,
      reason: "Queue request failed or returned invalid counts",
    }
  }
}
