import { logger } from "./logger"

/** Time an operation without changing its timeout, retries, or error identity. */
export async function diagnose<T>(
  operation: string,
  context: Record<string, unknown>,
  execute: () => Promise<T>,
  heartbeatMs = 10000
): Promise<T> {
  if (!logger.verbose) return execute()
  const started = Date.now()
  logger.trace(`${operation} started`, context)
  const heartbeat = setInterval(() => {
    logger.debug(`${operation} still waiting`, { ...context, elapsedMs: Date.now() - started })
  }, heartbeatMs)
  try {
    const result = await execute()
    logger.trace(`${operation} completed`, { ...context, durationMs: Date.now() - started })
    return result
  } catch (error) {
    // Errors and payloads can contain credentials or transcript content.
    logger.debug(`${operation} failed`, { ...context, durationMs: Date.now() - started })
    throw error
  } finally {
    clearInterval(heartbeat)
  }
}
