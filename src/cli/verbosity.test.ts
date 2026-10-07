import { expect, test } from "bun:test"
import { parseVerbosity } from "./verbosity"

test("global verbosity flags can appear before and after the command", () => {
  expect(parseVerbosity(["-v", "serve", "--port", "3001", "--verbose", "-vv"])).toEqual({
    args: ["serve", "--port", "3001"],
    verbosity: 4,
  })
  expect(parseVerbosity(["run", "-p", "atlas-agent-engine"])).toEqual({
    args: ["run", "-p", "atlas-agent-engine"],
    verbosity: 0,
  })
})
