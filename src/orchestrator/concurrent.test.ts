import { expect, test } from "bun:test"
import { ConcurrentExecutor } from "./concurrent"
import { startRun, endRun, requestStop } from "../server/runState"
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

test("bounded workers refill while a slow task remains in flight and preserve result order", async () => {
  const slow = gate(),
    third = gate(),
    releaseThird = gate()
  let active = 0,
    peak = 0,
    slowFinished = false
  const started: number[] = []
  const run = ConcurrentExecutor.execute(
    [0, 1, 2, 3],
    2,
    "pool-refill",
    "test",
    async ({ item }) => {
      started.push(item)
      peak = Math.max(peak, ++active)
      if (item === 0) {
        await slow.promise
        slowFinished = true
      }
      if (item === 2) {
        third.resolve()
        await releaseThird.promise
      }
      active--
      return item * 2
    }
  )
  await third.promise
  expect(slowFinished).toBe(false)
  expect(started).toEqual([0, 1, 2])
  releaseThird.resolve()
  slow.resolve()
  expect(await run).toEqual([0, 2, 4, 6])
  expect(peak).toBe(2)
})

test("failure stops new scheduling and waits for in-flight receipt persistence", async () => {
  const slow = gate(),
    failed = gate(),
    started: number[] = []
  let saved = false,
    finished = false
  const run = ConcurrentExecutor.executePool({
    items: [0, 1, 2],
    concurrency: 2,
    rateLimitMs: 0,
    runId: "pool-error",
    phaseName: "test",
    executeTask: async ({ item }) => {
      started.push(item)
      if (item === 1) throw new Error("write failed")
      await slow.promise
      saved = true
      return item
    },
    onError: () => failed.resolve(),
  }).then(
    () => {
      finished = true
      return null
    },
    (e) => {
      finished = true
      return e
    }
  )
  await failed.promise
  expect(finished).toBe(false)
  expect(started).toEqual([0, 1])
  slow.resolve()
  expect((await run).message).toBe("write failed")
  expect(saved).toBe(true)
})

test("stop prevents fresh work while allowing the in-flight task to finish", async () => {
  const id = "pool-stop",
    slow = gate(),
    stopped = gate(),
    started: number[] = []
  startRun(id)
  try {
    const run = ConcurrentExecutor.execute([0, 1, 2], 2, id, "test", async ({ item }) => {
      started.push(item)
      if (item === 0) await slow.promise
      else {
        requestStop(id)
        stopped.resolve()
      }
      return item
    }).then(
      () => null,
      (e) => e
    )
    await stopped.promise
    expect(started).toEqual([0, 1])
    slow.resolve()
    expect((await run).message).toContain("stopped by user")
  } finally {
    slow.resolve()
    endRun(id)
  }
})

test("invalid concurrency fails before running tasks", async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity])
    await expect(
      ConcurrentExecutor.execute([1], concurrency, "pool-invalid", "test", async () => 1)
    ).rejects.toThrow("positive integer")
})
