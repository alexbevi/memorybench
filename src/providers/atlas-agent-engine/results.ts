import type { MemoryChunk } from "@mongodb-js/agent-engine-sdk-memory"
import type { SearchOptions } from "../../types/provider"

export function searchLimit(options: SearchOptions) {
  const limit = options.limit ?? 10
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("Atlas search limit must be a nonnegative integer.")
  if (options.threshold !== undefined && !Number.isFinite(options.threshold))
    throw new Error("Atlas threshold must be finite.")
  return limit
}
export function normalize(hits: MemoryChunk[], options: SearchOptions) {
  const seen = new Set<string>()
  return hits
    .filter((hit) => {
      const key = `${hit.source}:${hit.id}`
      const score = hit.similarity_score
      if (
        !hit.content.trim() ||
        seen.has(key) ||
        (options.threshold !== undefined &&
          (typeof score !== "number" || !Number.isFinite(score) || score < options.threshold))
      )
        return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.similarity_score ?? -Infinity) - (a.similarity_score ?? -Infinity))
    .slice(0, searchLimit(options))
    .map((hit) => {
      const meta = hit.metadata ?? {}
      return {
        id: hit.id,
        content: hit.content,
        source: hit.source,
        ...(typeof hit.similarity_score === "number" && Number.isFinite(hit.similarity_score)
          ? { score: hit.similarity_score }
          : {}),
        recordedAt: hit.timestamp.toISOString(),
        ...(typeof meta.sourceSessionId === "string"
          ? { sourceSessionId: meta.sourceSessionId }
          : {}),
        ...(typeof meta.sourceDate === "string" ? { sourceDate: meta.sourceDate } : {}),
      }
    })
}
