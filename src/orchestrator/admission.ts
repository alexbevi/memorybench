import type { Provider, QueueObservation } from "../types/provider"
import { observeQueue } from "./queue"
export interface BacklogPolicy {
  mode: "warn" | "wait" | "proceed"
  timeoutMs: number
}
export interface Admission {
  policy: BacklogPolicy
  baseline: QueueObservation
  latest: QueueObservation
  decision: "waiting" | "admitted" | "warned" | "proceeded" | "failed"
  waitMs: number
}
export function backlogPolicy(value?: Partial<BacklogPolicy>): BacklogPolicy {
  const mode = value?.mode ?? "warn",
    timeoutMs = value?.timeoutMs ?? 300000
  if (
    !["warn", "wait", "proceed"].includes(mode) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 3600000
  )
    throw new Error("Backlog policy requires warn, wait, or proceed and a timeout of 1–3600000 ms")
  return { mode, timeoutMs }
}
export async function admitWork(
  provider: Pick<Provider, "observeQueue">,
  policy: BacklogPolicy,
  save: (state: Admission) => void,
  deps: { checkStop?: () => void; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
) {
  const now = deps.now ?? Date.now,
    sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const start = now()
  deps.checkStop?.()
  const baseline = await observeQueue(provider)
  const state: Admission = { policy, baseline, latest: baseline, decision: "waiting", waitMs: 0 }
  let empty = 0
  try {
    while (true) {
      deps.checkStop?.()
      state.waitMs = now() - start
      if (policy.mode !== "wait") {
        state.decision =
          policy.mode === "proceed"
            ? "proceeded"
            : state.latest.status !== "available" || state.latest.queued + state.latest.running > 0
              ? "warned"
              : "admitted"
        save({ ...state })
        return
      }
      if (state.latest.status !== "available")
        throw new Error("Cannot wait for backlog: queue observation is unavailable or unsupported")
      empty = state.latest.queued + state.latest.running === 0 ? empty + 1 : 0
      if (empty >= 3) {
        state.decision = "admitted"
        save({ ...state })
        return
      }
      if (now() - start >= policy.timeoutMs)
        throw new Error("Backlog admission timed out before ingestion")
      save({ ...state })
      await sleep(Math.min(1000, policy.timeoutMs - (now() - start)))
      deps.checkStop?.()
      state.latest = await observeQueue(provider)
    }
  } catch (error) {
    state.decision = "failed"
    state.waitMs = now() - start
    save({ ...state })
    throw error
  }
}
