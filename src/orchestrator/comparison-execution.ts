export type ComparisonExecution = "sequential" | "parallel"
export function comparisonExecutionOptions(
  concurrency: unknown = 2,
  execution: unknown = "sequential"
) {
  if (typeof concurrency !== "number" || !Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Comparison concurrency must be a positive integer")
  if (execution !== "sequential" && execution !== "parallel")
    throw new Error("Comparison execution must be sequential or parallel")
  return { concurrency, execution: execution as ComparisonExecution }
}
export async function executeComparisonTasks<T>(
  tasks: (() => Promise<T>)[],
  execution: ComparisonExecution
): Promise<PromiseSettledResult<T>[]> {
  if (execution === "parallel") return Promise.allSettled(tasks.map((task) => task()))
  const results: PromiseSettledResult<T>[] = []
  for (const task of tasks) {
    try {
      results.push({ status: "fulfilled", value: await task() })
    } catch (reason) {
      results.push({ status: "rejected", reason })
    }
  }
  return results
}
