import { expect, spyOn, test } from "bun:test"
import { diagnose } from "./diagnostics"
import { logger } from "./logger"

test("slow operations report context and elapsed time, then stop reporting", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {})
  logger.setVerbosity(2)
  try {
    let release!: (value: number) => void
    const pending = diagnose(
      "remote write",
      { tag: "run-a", write: 2 },
      () =>
        new Promise<number>((resolve) => {
          release = resolve
        }),
      5
    )
    await Bun.sleep(25)
    expect(output.mock.calls.flat().join("\n")).toContain("still waiting")
    expect(output.mock.calls.flat().join("\n")).toContain('"tag":"run-a"')
    release(42)
    expect(await pending).toBe(42)
    const count = output.mock.calls.length
    await Bun.sleep(20)
    expect(output.mock.calls.length).toBe(count)
  } finally {
    logger.setVerbosity(0)
    output.mockRestore()
  }
})

test("failed operations preserve errors, omit their content, and clear heartbeats", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {})
  logger.setVerbosity(2)
  try {
    const error = new Error("sensitive response body")
    await expect(
      diagnose(
        "write",
        {},
        async () => {
          throw error
        },
        5
      )
    ).rejects.toBe(error)
    expect(output.mock.calls.flat().join("\n")).not.toContain(error.message)
    const count = output.mock.calls.length
    await Bun.sleep(20)
    expect(output.mock.calls.length).toBe(count)
  } finally {
    logger.setVerbosity(0)
    output.mockRestore()
  }
})
