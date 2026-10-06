import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile, unlink, open } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
const writeSchema = z.object({
  key: z.string(),
  content: z.string(),
  role: z.string(),
  id: z.string().optional(),
  pending: z.boolean(),
})
const sessionSchema = z.object({
  sourceId: z.string(),
  fingerprint: z.string(),
  remoteId: z.string(),
  lastWrite: z.number(),
  writes: z.array(writeSchema),
})
const schema = z.object({
  version: z.literal(1),
  connection: z.string(),
  sessions: z.record(sessionSchema),
})
export type SessionState = z.infer<typeof sessionSchema>
export type State = z.infer<typeof schema>

export class Store {
  constructor(readonly directory: string) {}
  path(scope: string) {
    return join(this.directory, `${scope}.json`)
  }
  async read(scope: string, connection: string): Promise<State> {
    let raw: string
    try {
      raw = await readFile(this.path(scope), "utf8")
    } catch (e: any) {
      if (e.code === "ENOENT") return { version: 1, connection, sessions: {} }
      throw e
    }
    const state = schema.parse(JSON.parse(raw))
    if (state.connection !== connection)
      throw new Error("Atlas manifest connection changed; use a new run ID.")
    return state
  }
  async save(scope: string, state: State) {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${this.path(scope)}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, this.path(scope))
  }
  async lock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true })
    const path = `${this.path(scope)}.lock`
    let handle
    try {
      handle = await open(path, "wx", 0o600)
    } catch {
      throw new Error(`Atlas scope locked. Stop other writers before removing ${path}`)
    }
    try {
      await handle.writeFile(String(process.pid))
      return await fn()
    } finally {
      await handle.close()
      await unlink(path)
    }
  }
}
