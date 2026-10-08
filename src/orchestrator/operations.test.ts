import { expect, test } from "bun:test"
import { operationalSummary } from "./operations"
import type { RunCheckpoint } from "../types/checkpoint"
test("readiness failures retain operational evidence without claiming completion or quality", () => {
  const c = {
    questions: {
      q: {
        phases: {
          ingest: {
            completedSessions: ["s1"],
            uploads: [
              { attempt: 0, outcome: "accepted", durationMs: 100, messages: 8 },
              { attempt: 0, outcome: "failed", durationMs: 200, messages: 2 },
            ],
          },
        },
      },
    },
    operationalAttempts: [
      {
        startedAt: "2026-01-01T00:00:00Z",
        ingestStartedAt: "2026-01-01T00:00:01Z",
        ingestFinishedAt: "2026-01-01T00:00:03Z",
        indexingStartedAt: "2026-01-01T00:00:03Z",
        finishedAt: "2026-01-01T00:15:03Z",
        outcome: "failed",
      },
    ],
  } as unknown as RunCheckpoint
  const result = operationalSummary(c).attempts[0]
  expect(result.acceptedSourceMessages).toBe(8)
  expect(result.acceptedMessagesPerSecond).toBe(4)
  expect(result.failedSessionUploads).toBe(1)
  expect(result.readinessWaitMs).toBe(900000)
  expect(result.ingestionToReadinessMs).toBeNull()
  expect(result.failedUploadLatency.p95Ms).toBe(200)
  c.operationalAttempts!.push({ startedAt: "2026-01-01T01:00:00Z", outcome: "running" })
  expect(operationalSummary(c).attempts[1].acceptedSessionUploads).toBe(0)
  expect(operationalSummary(c).attempts[1].successfulUploadLatency.p95Ms).toBeNull()
})
