import { test, expect } from "bun:test"
import { measureSearch, searchMeasurementOptions } from "./search-measurement"
test("search timings exclude warmups and answering uses the first measured result", async () => {
  let calls = 0
  const result = await measureSearch(
    { search: async () => [{ id: ++calls }] },
    "query",
    { containerTag: "scope", limit: 10 },
    { warmupRequests: 2, repetitions: 3 }
  )
  expect(calls).toBe(5)
  expect(result.samples).toHaveLength(3)
  expect(result.results).toEqual([{ id: 3 }])
  expect(result.samples.every((n) => n >= 0)).toBe(true)
})
test("measurement bounds reject invalid or accidental request explosions", () => {
  expect(() => searchMeasurementOptions({ repetitions: 0 })).toThrow()
  expect(() => searchMeasurementOptions({ warmupRequests: 11 })).toThrow()
  expect(() => searchMeasurementOptions({ repetitions: 1.5 })).toThrow()
})
