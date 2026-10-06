import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AtlasAgentEngineDirectProvider, AtlasAgentEngineProvider, TIMEOUT_MS } from "./index"
import { chunks } from "./content"

const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
export async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "atlas-test-"))
  directories.push(stateDir)
  let time = 1000
  const episodes: any[] = []
  const requests: { url: string; body: any }[] = []
  let loseResponse = false
  let visible = true
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    requests.push({ url, body })
    if (url.endsWith("/turns")) {
      const id = `turn-${requests.filter((r) => r.url.endsWith("/turns")).length}`
      if (!episodes.some((e) => e.session_id === body.session_id))
        episodes.push({
          ...body,
          id: `episode-${id}`,
          source: "episodic",
          timestamp: new Date().toISOString(),
          similarity_score: 0.8,
        })
      return Response.json({
        id,
        session_id: body.session_id,
        turn_seq: 1,
        acknowledged: true,
        has_embedding: false,
      })
    }
    if (url.endsWith("/episodic") && init.method === "POST") {
      const episode = {
        ...body,
        id: String(episodes.length + 1),
        source: "episodic",
        timestamp: new Date().toISOString(),
        similarity_score: 0.8,
      }
      episodes.push(episode)
      if (loseResponse) {
        loseResponse = false
        throw new Error("connection lost")
      }
      return Response.json({
        id: episode.id,
        title: body.title,
        acknowledged: true,
        has_embedding: true,
      })
    }
    if (url.includes("/episodic?")) {
      const params = new URL(url).searchParams
      return Response.json({
        entries: episodes.filter(
          (e) => e.user_id === params.get("user_id") && e.session_id === params.get("session_id")
        ),
      })
    }
    if (url.endsWith("/search"))
      return Response.json({
        memories: visible
          ? episodes.filter(
              (e) =>
                e.user_id === body.user_id && (!body.session_id || e.session_id === body.session_id)
            )
          : [],
      })
    return Response.json({}, { status: 404 })
  }
  const deps = {
    stateDir,
    fetchImpl,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
  }
  const create = async () => {
    const p = new AtlasAgentEngineDirectProvider(deps)
    await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
    return p
  }
  return {
    create,
    deps,
    episodes,
    requests,
    lose: () => {
      loseResponse = true
    },
    hide: () => {
      visible = false
    },
    time: () => time,
  }
}
const session = {
  sessionId: "s1",
  messages: [
    {
      role: "user" as const,
      content: "My home airport is Boston.",
      speaker: "Alice",
      timestamp: "2024-01-01",
    },
  ],
}

test("chunks cover long Unicode input without splitting characters", () => {
  const text = "🙂 abc\n".repeat(2000)
  const parts = chunks(text)
  expect(parts.length).toBeGreaterThan(1)
  let rebuilt = ""
  let end = 0
  for (const part of parts) {
    expect(Array.from(part.content).length).toBeLessThanOrEqual(1600)
    rebuilt += Array.from(part.content)
      .slice(Math.max(0, end - part.start))
      .join("")
    end = part.end
  }
  expect(rebuilt).toBe(text)
})
test("SDK direct write, indexing, restart, and scope isolation", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([session], { containerTag: "run-a" })
  await p.awaitIndexing(result, "run-a")
  const resumed = await f.create()
  expect(await resumed.ingest([session], { containerTag: "run-a" })).toEqual(result)
  expect(f.episodes).toHaveLength(1)
  expect(await resumed.search("airport", { containerTag: "run-a" })).toHaveLength(1)
  expect(await resumed.search("airport", { containerTag: "run-b" })).toHaveLength(0)
  expect(f.episodes[0].visibility).toBe("private")
  expect(f.requests[0].url).toBe("http://localhost:8000/api/v1/memory/episodic")
  await expect(resumed.clear("run-a")).rejects.toThrow("unsupported")
  await expect(
    resumed.ingest([{ ...session, messages: [] }], { containerTag: "run-a" })
  ).rejects.toThrow("changed")
})
test("uncertain episode write reconciles without a duplicate create", async () => {
  const f = await fixture()
  const p = await f.create()
  f.lose()
  await expect(p.ingest([session], { containerTag: "run" })).rejects.toThrow()
  const resumed = await f.create()
  expect((await resumed.ingest([session], { containerTag: "run" })).documentIds).toEqual(["1"])
  expect(f.episodes).toHaveLength(1)
})
test("unsearchable writes time out rather than pass indexing", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([session], { containerTag: "run" })
  f.hide()
  await expect(p.awaitIndexing(result, "run")).rejects.toThrow("timed out")
  expect(f.time()).toBeGreaterThanOrEqual(TIMEOUT_MS)
})

test("conversation extraction waits, preserves turns, and searches both sources", async () => {
  const f = await fixture()
  const p = new AtlasAgentEngineProvider(f.deps)
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest([session, { ...session, sessionId: "s2" }], { containerTag: "run" })
  await p.awaitIndexing(result, "run")
  expect(f.time()).toBeGreaterThanOrEqual(241000)
  const writes = f.requests.filter((r) => r.url.endsWith("/turns"))
  expect(writes).toHaveLength(2)
  expect(writes[0].body.role).toBe("user")
  expect(writes[0].body.content).toContain("Source date: 2024-01-01")
  await p.search("airport", { containerTag: "run" })
  expect(f.requests.slice(-2).map((r) => r.body.type)).toEqual(["semantic", "episodic"])
  const restarted = new AtlasAgentEngineProvider(f.deps)
  await restarted.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  expect(await restarted.ingest([session], { containerTag: "run" })).toEqual({
    documentIds: [result.documentIds[0]],
  })
})
test("conversation mode cannot pass when one session has no searchable episode", async () => {
  const f = await fixture()
  const p = new AtlasAgentEngineProvider(f.deps)
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest([session, { ...session, sessionId: "missing" }], {
    containerTag: "run",
  })
  f.episodes.pop()
  await expect(p.awaitIndexing(result, "run")).rejects.toThrow("readiness timed out")
})

test("hosted SDK uses project routes and bearer token without persisting credentials", async () => {
  const f = await fixture()
  let authorization: string | null = null
  const p = new AtlasAgentEngineDirectProvider({
    ...f.deps,
    fetchImpl: async (url, init) => {
      authorization = new Headers(init.headers).get("authorization")
      return f.deps.fetchImpl(url, init)
    },
  })
  await p.initialize({ apiKey: "test-token", projectId: "project one" })
  await p.ingest([session], { containerTag: "hosted" })
  expect(f.requests[0].url).toBe(
    "https://agentengine.mongodb.com/api/v1/projects/project%20one/memory/episodic"
  )
  expect(authorization as string | null).toBe("Bearer test-token")
  const { readdir, readFile } = await import("node:fs/promises")
  for (const name of await readdir(f.deps.stateDir))
    expect(await readFile(join(f.deps.stateDir, name), "utf8")).not.toContain("test-token")
  const renewed = new AtlasAgentEngineDirectProvider(f.deps)
  await renewed.initialize({ apiKey: "new-token", projectId: "project one" })
  await renewed.ingest([session], { containerTag: "hosted" })
  expect(f.episodes).toHaveLength(1)
})
test("invalid configuration and authentication responses fail without leaking secrets", async () => {
  const p = new AtlasAgentEngineDirectProvider()
  await expect(p.initialize({ apiKey: "secret" })).rejects.toThrow("requires both")
  await expect(
    p.initialize({ apiKey: "secret", projectId: "p", baseUrl: "http://localhost" })
  ).rejects.toThrow("HTTPS")
  const f = await fixture()
  const failing = new AtlasAgentEngineDirectProvider({
    ...f.deps,
    fetchImpl: async () => Response.json({ detail: "secret-token" }, { status: 401 }),
  })
  await failing.initialize({ apiKey: "secret-token", projectId: "p" })
  await expect(failing.ingest([session], { containerTag: "run" })).rejects.toThrow("HTTP 401")
  try {
    await failing.search("airport", { containerTag: "run" })
  } catch (e) {
    expect(String(e)).not.toContain("secret-token")
  }
})
