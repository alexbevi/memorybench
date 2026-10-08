import type { Provider, QueueObservation } from "../types/provider"

export async function observeQueue(
  provider: Pick<Provider, "observeQueue">
): Promise<QueueObservation> {
  const checkedAt = new Date().toISOString()
  if (!provider.observeQueue) return { status: "unsupported", scope: "service", checkedAt }
  try {
    return await provider.observeQueue()
  } catch {
    return { status: "unavailable", scope: "service", checkedAt, reason: "Queue request failed" }
  }
}

export async function monitorQueue(
  provider: Provider,
  save: (value: QueueObservation) => void,
  intervalMs = 10000
) {
  let pending: Promise<void> | undefined
  const poll = () =>
    (pending ??= observeQueue(provider)
      .then(save)
      .finally(() => {
        pending = undefined
      }))
  await poll()
  const timer = provider.observeQueue
    ? setInterval(() => {
        void poll()
      }, intervalMs)
    : undefined
  return async () => {
    if (timer) clearInterval(timer)
    await pending
    if (provider.observeQueue) await poll()
  }
}
