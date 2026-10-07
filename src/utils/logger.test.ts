import { expect, spyOn, test } from "bun:test"
import { Logger } from "./logger"

for (const verbosity of [0, 1, 2, 3]) {
  test(`verbosity ${verbosity} filters diagnostic levels`, () => {
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      const log = new Logger()
      log.setVerbosity(verbosity)
      log.trace("trace message")
      log.debug("debug message")
      log.info("info message")
      expect(output.mock.calls.length).toBe(Math.min(verbosity, 2) + 1)
      expect(output.mock.calls.flat().join(" ")).toContain("info message")
      if (verbosity < 2) expect(output.mock.calls.flat().join(" ")).not.toContain("trace message")
      if (verbosity === 0) expect(output.mock.calls.flat().join(" ")).not.toContain("debug message")
      log.setVerbosity(0)
      expect(log.verbose).toBe(false)
    } finally {
      output.mockRestore()
    }
  })
}
