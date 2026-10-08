import { test, expect } from "bun:test"
import { comparisonExecutionOptions, executeComparisonTasks } from "./comparison-execution"
test("new comparisons use shared concurrency and sequential execution", () => {
  expect(comparisonExecutionOptions()).toEqual({ concurrency: 2, execution: "sequential" })
  for (const value of [0, -1, 1.5, NaN, "2"])
    expect(() => comparisonExecutionOptions(value)).toThrow()
})
test("sequential provider execution waits and continues after a failed provider", async () => {
  let active = 0,
    peak = 0
  const tasks = [0, 1, 2].map((i) => async () => {
    active++
    peak = Math.max(peak, active)
    await Bun.sleep(1)
    active--
    if (i === 1) throw new Error("failed")
    return i
  })
  const result = await executeComparisonTasks(tasks, "sequential")
  expect(peak).toBe(1)
  expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
  await executeComparisonTasks(tasks, "parallel")
  expect(peak).toBe(3)
})
