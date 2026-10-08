import { expect, test } from "bun:test"
import { admitWork, backlogPolicy, type Admission } from "./admission"
import type { QueueObservation } from "../types/provider"
const observation = (queued: number): QueueObservation => ({
  status: "available",
  scope: "service",
  checkedAt: "now",
  queued,
  running: 0,
  failed: 4,
})
test("warn and deliberate proceed work for providers without queue capability", async () => {
  for (const mode of ["warn", "proceed"] as const) {
    let state: Admission | undefined
    await admitWork({}, backlogPolicy({ mode }), (s) => (state = s))
    expect(state?.decision).toBe(mode === "warn" ? "warned" : "proceeded")
    expect(state?.latest.status).toBe("unsupported")
  }
  await expect(admitWork({}, backlogPolicy({ mode: "wait" }), () => {})).rejects.toThrow(
    "unsupported"
  )
})
test("wait requires repeated quiet observations and records baseline and failures separately", async () => {
  let time = 0,
    i = 0
  const counts = [3, 0, 2, 0, 0, 0],
    states: Admission[] = []
  await admitWork(
    { observeQueue: async () => observation(counts[i++]) },
    backlogPolicy({ mode: "wait", timeoutMs: 10000 }),
    (s) => states.push(s),
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    }
  )
  expect(i).toBe(6)
  expect(states.at(-1)?.decision).toBe("admitted")
  expect(states.at(-1)?.baseline).toEqual(observation(3))
  expect(states.at(-1)?.waitMs).toBe(5000)
})
test("timeout and local stop cannot proceed to ingestion", async () => {
  let time = 0,
    state: Admission | undefined
  await expect(
    admitWork(
      { observeQueue: async () => observation(4) },
      backlogPolicy({ mode: "wait", timeoutMs: 1000 }),
      (s) => (state = s),
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
      }
    )
  ).rejects.toThrow("timed out")
  expect(state?.decision).toBe("failed")
  await expect(
    admitWork({}, backlogPolicy(), () => {}, {
      checkStop: () => {
        throw new Error("stopped")
      },
    })
  ).rejects.toThrow("stopped")
  expect(() => backlogPolicy({ mode: "typo" as any })).toThrow()
})
