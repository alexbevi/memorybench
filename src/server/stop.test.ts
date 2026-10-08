import { afterEach, expect, test } from "bun:test"
import { startRun, endRun, shouldStop } from "./runState"
import { stopLocalRun } from "./stop"
const id = "stop-contract-test"
afterEach(() => endRun(id))

test("legacy and explicit local stop requests acknowledge only local cancellation", () => {
  for (const input of [{}, { scope: "local" }]) {
    startRun(id)
    const response = stopLocalRun(id, input)
    expect(response.status).toBe(200)
    expect(response.body.remoteCancellation).toBe("not-requested")
    expect(shouldStop(id)).toBe(true)
  }
})

test("unsupported remote cancellation does not silently stop local work", () => {
  startRun(id)
  for (const scope of ["remote", "all"]) {
    expect(stopLocalRun(id, { scope }).status).toBe(409)
    expect(shouldStop(id)).toBe(false)
  }
  expect(stopLocalRun(id, { scope: "typo" }).status).toBe(400)
  expect(stopLocalRun(id, null).status).toBe(400)
  expect(stopLocalRun("missing", {}).status).toBe(404)
})
