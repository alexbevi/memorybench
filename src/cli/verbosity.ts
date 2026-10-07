/** Extract repeatable global flags before dispatching to command parsers. */
export function parseVerbosity(args: string[]): { args: string[]; verbosity: number } {
  let verbosity = 0
  const remaining: string[] = []
  for (const arg of args) {
    if (arg === "--verbose") verbosity++
    else if (/^-v+$/.test(arg)) verbosity += arg.length - 1
    else remaining.push(arg)
  }
  return { args: remaining, verbosity }
}
