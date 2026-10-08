"use client"
import { useEffect, useState } from "react"
import { getRunQueue, type QueueObservation } from "@/lib/api"
export function QueueHealth({ runId, baseline }: { runId: string; baseline?: QueueObservation }) {
  const [current, setCurrent] = useState<QueueObservation>()
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await getRunQueue(runId)
        if (!closed) setCurrent(value)
      } catch {
        if (!closed)
          setCurrent({
            status: "unavailable",
            scope: "service",
            checkedAt: new Date().toISOString(),
          })
      }
      if (!closed) timer = setTimeout(poll, 10000)
    }
    void poll()
    return () => {
      closed = true
      clearTimeout(timer)
    }
  }, [runId])
  const describe = (value?: QueueObservation) =>
    !value
      ? "Checking…"
      : value.status === "available"
        ? `${value.queued.toLocaleString()} queued · ${value.running} running · ${value.failed} failed`
        : value.status === "unsupported"
          ? "Queue observation unsupported"
          : "Queue observation unavailable"
  return (
    <div className="text-sm text-text-secondary">
      <p className="font-medium">Service-wide extraction queue</p>
      <p aria-live="polite">{describe(current)}</p>
      {baseline && <p>Run baseline: {describe(baseline)}</p>}
      <p className="text-xs mt-2">
        Includes other runs. Empty does not prove this run extracted successfully. Remote work may
        continue after a local stop.
      </p>
      {current && <p className="text-xs">Observed {current.checkedAt}</p>}
    </div>
  )
}
