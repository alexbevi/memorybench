import { logger } from "../utils/logger"
import { shouldStop, assertRunNotStopped } from "../server/runState"

export interface ConcurrentTaskContext<T> {
  item: T
  index: number
  total: number
}

export interface ConcurrentExecutionOptions<T, R> {
  items: T[]
  concurrency: number
  rateLimitMs: number
  runId: string
  phaseName: string
  executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  onBatchStart?: (batchIndex: number, batchSize: number) => void
  onBatchComplete?: (batchIndex: number, results: R[]) => void
  onTaskComplete?: (context: ConcurrentTaskContext<T>, result: R) => void
  onError?: (context: ConcurrentTaskContext<T>, error: Error) => void
}

export class ConcurrentExecutor {
  // Refill a free slot without waiting for slower tasks. On failure, stop
  // scheduling but await every in-flight task so it can persist its receipts.
  static async executePool<T, R>(
    options: Omit<ConcurrentExecutionOptions<T, R>, "onBatchStart" | "onBatchComplete">
  ): Promise<R[]> {
    const {
      items,
      concurrency,
      rateLimitMs,
      runId,
      phaseName,
      executeTask,
      onTaskComplete,
      onError,
    } = options
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
      throw new Error("Concurrency must be a positive integer")
    if (!Number.isFinite(rateLimitMs) || rateLimitMs < 0)
      throw new Error("Worker cooldown must be nonnegative")
    assertRunNotStopped(runId)
    const results = new Array<R>(items.length)
    let next = 0
    let firstError: Error | undefined
    logger.info(
      `[${phaseName}] Processing ${items.length} items with ${concurrency} bounded workers (cooldown: ${rateLimitMs}ms per worker)`
    )
    const worker = async () => {
      while (next < items.length && !firstError && !shouldStop(runId)) {
        const index = next++
        const context = { item: items[index], index, total: items.length }
        try {
          const result = await executeTask(context)
          results[index] = result
          onTaskComplete?.(context, result)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          firstError ??= failure
          onError?.(context, failure)
          return
        }
        if (next < items.length && !firstError && !shouldStop(runId) && rateLimitMs > 0)
          await new Promise((resolve) => setTimeout(resolve, rateLimitMs))
      }
    }
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(items.length, concurrency) }, worker)
    )
    if (firstError) throw firstError
    const rejected = settled.find((r) => r.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
    assertRunNotStopped(runId)
    return results
  }

  /**
   * Execute tasks concurrently in batches with rate limiting
   * Throws on first error (fail-fast), but ensures in-flight operations complete
   */
  static async executeBatched<T, R>(options: ConcurrentExecutionOptions<T, R>): Promise<R[]> {
    const {
      items,
      concurrency,
      rateLimitMs,
      runId,
      phaseName,
      executeTask,
      onBatchStart,
      onBatchComplete,
      onTaskComplete,
      onError,
    } = options

    if (items.length === 0) return []
    if (concurrency <= 0) throw new Error("Concurrency must be positive")

    const batchSize = concurrency
    const totalBatches = Math.ceil(items.length / batchSize)
    const allResults: R[] = []

    logger.info(
      `[${phaseName}] Processing ${items.length} items with concurrency ${concurrency} (${totalBatches} batches)`
    )

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      if (shouldStop(runId)) {
        logger.info(`[${phaseName}] Run ${runId} stopped by user`)
        throw new Error(`Run stopped by user. Resume with the same run ID.`)
      }

      const batchStart = batchIdx * batchSize
      const batchEnd = Math.min(batchStart + batchSize, items.length)
      const batch = items.slice(batchStart, batchEnd)

      logger.debug(`[${phaseName}] Starting batch ${batchIdx + 1}/${totalBatches}`, {
        runId,
        items: batch.length,
      })
      onBatchStart?.(batchIdx, batch.length)

      const batchPromises = batch.map(async (item, batchOffset) => {
        const globalIndex = batchStart + batchOffset
        const context: ConcurrentTaskContext<T> = {
          item,
          index: globalIndex,
          total: items.length,
        }

        try {
          const result = await executeTask(context)
          onTaskComplete?.(context, result)
          return { success: true as const, result, context }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          onError?.(context, err)
          return { success: false as const, error: err, context }
        }
      })

      const batchResults = await Promise.all(batchPromises)

      const firstError = batchResults.find((r) => !r.success)
      if (firstError && !firstError.success) {
        throw firstError.error
      }

      const successfulResults = batchResults.filter((r) => r.success).map((r) => r.result as R)

      allResults.push(...successfulResults)
      logger.debug(`[${phaseName}] Completed batch ${batchIdx + 1}/${totalBatches}`, { runId })
      onBatchComplete?.(batchIdx, successfulResults)

      // Catch stops during the final batch too, before a later phase can start.
      assertRunNotStopped(runId)

      if (batchIdx < totalBatches - 1 && rateLimitMs > 0) {
        logger.debug(`[${phaseName}] Waiting ${rateLimitMs}ms before next batch`)
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs))
      }
    }

    return allResults
  }

  /**
   * Simple concurrent execution without batching (for phases without rate limits)
   */
  static async execute<T, R>(
    items: T[],
    concurrency: number,
    runId: string,
    phaseName: string,
    executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  ): Promise<R[]> {
    return this.executePool({
      items,
      concurrency,
      rateLimitMs: 0,
      runId,
      phaseName,
      executeTask,
    })
  }
}
