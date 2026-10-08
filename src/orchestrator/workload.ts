import type { Benchmark } from "../types/benchmark"
import type { Provider } from "../types/provider"
import { digest } from "../utils/provenance"
export interface Workload {
  questions: number
  distinctHistories: number
  repeatedHistories: number
  sessions: number
  messages: number
  writes?: { count: number; unit: string }
  reusePolicy: "per-question"
}
export function estimateWorkload(
  benchmark: Benchmark,
  ids: string[],
  provider: Pick<Provider, "estimateWrites">
): Workload {
  const histories = new Set<string>()
  const result: Workload = {
    questions: ids.length,
    distinctHistories: 0,
    repeatedHistories: 0,
    sessions: 0,
    messages: 0,
    reusePolicy: "per-question",
  }
  for (const id of ids) {
    const sessions = benchmark.getHaystackSessions(id)
    histories.add(digest(sessions))
    result.sessions += sessions.length
    result.messages += sessions.reduce((n, s) => n + s.messages.length, 0)
    const writes = provider.estimateWrites?.(sessions)
    if (writes) {
      if (result.writes && result.writes.unit !== writes.unit)
        throw new Error("Inconsistent write units")
      result.writes = { unit: writes.unit, count: (result.writes?.count ?? 0) + writes.count }
    }
  }
  result.distinctHistories = histories.size
  result.repeatedHistories = ids.length - histories.size
  return result
}
