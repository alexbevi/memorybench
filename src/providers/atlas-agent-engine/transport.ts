import type { FetchLike } from "@mongodb-js/agent-engine-sdk-memory"
import { logger } from "../../utils/logger"

/** The server omits vectors with null; the underlying SDK requires an absent field. */
export function compatibleFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const response = await fetchImpl(url, init)
    if (!response.ok || !new URL(url).pathname.endsWith("/memory/search")) return response
    let body: any
    try {
      body = await response.clone().json()
    } catch {
      // Preserve malformed responses so the SDK reports the contract violation.
      return response
    }
    if (!Array.isArray(body?.memories)) return response
    let changed = 0
    for (const memory of body.memories) {
      if (memory && typeof memory === "object" && memory.embedding === null) {
        delete memory.embedding
        changed++
      }
    }
    if (!changed) return response
    logger.trace("[atlas] Normalized omitted search embeddings", { count: changed })
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
