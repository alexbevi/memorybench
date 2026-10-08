import { logger } from "../../utils/logger"
import { afterEach, expect, spyOn, test } from "bun:test"
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

test("normalization honors zero threshold, excludes missing scores, and drops embeddings", async () => {
  const { normalize } = await import("./results")
  const hit = {
    id: "a",
    source: "episodic" as const,
    content: "Fact",
    timestamp: new Date("2024-01-01"),
    embedding: [1, 2],
    similarity_score: 0,
    metadata: { sourceDate: "2020-01-01", sourceSessionId: "s", huge: "omit" },
  }
  const results = normalize(
    [
      hit,
      hit,
      { ...hit, id: "b", similarity_score: null },
      { ...hit, id: "c", similarity_score: -0.2 },
    ],
    { containerTag: "run", threshold: 0 }
  )
  expect(results).toHaveLength(1)
  expect(results[0].sourceDate).toBe("2020-01-01")
  expect(results[0].recordedAt).toBe("2024-01-01T00:00:00.000Z")
  expect(JSON.stringify(results)).not.toContain("embedding")
  expect(JSON.stringify(results)).not.toContain("huge")
  const f = await fixture()
  const p = await f.create()
  expect(await p.search("q", { containerTag: "run", limit: 0 })).toEqual([])
  expect(f.requests).toHaveLength(0)
  await expect(p.search("q", { containerTag: "run", limit: -1 })).rejects.toThrow("limit")
})

test("long messages repeat speaker/date context and keep source metadata", async () => {
  const f = await fixture()
  const p = await f.create()
  await p.ingest(
    [
      {
        ...session,
        metadata: { date: "2020-01-01" },
        messages: [{ role: "assistant", speaker: "Bob", content: "x".repeat(4000) }],
      },
    ],
    { containerTag: "long" }
  )
  expect(f.episodes.length).toBeGreaterThan(1)
  for (const e of f.episodes) {
    expect(e.content).toContain("Speaker: Bob")
    expect(e.content).toContain("Role: assistant")
    expect(e.metadata.sourceDate).toBe("2020-01-01")
  }
})

test("failed reconciliation read cannot turn an uncertain write into a new create", async () => {
  const f = await fixture()
  const p = await f.create()
  f.lose()
  await expect(p.ingest([session], { containerTag: "run" })).rejects.toThrow()
  const authFailure = new AtlasAgentEngineDirectProvider({
    ...f.deps,
    fetchImpl: async () => Response.json({}, { status: 401 }),
  })
  await authFailure.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  await expect(authFailure.ingest([session], { containerTag: "run" })).rejects.toThrow("HTTP 401")
  const resumed = await f.create()
  await resumed.ingest([session], { containerTag: "run" })
  expect(f.episodes).toHaveLength(1)
})
test("unresolved uncertain creates remain blocked across resumes", async () => {
  const f = await fixture()
  const p = await f.create()
  f.lose()
  await expect(p.ingest([session], { containerTag: "run" })).rejects.toThrow()
  f.episodes.splice(0)
  for (let i = 0; i < 2; i++) {
    const resumed = await f.create()
    await expect(resumed.ingest([session], { containerTag: "run" })).rejects.toThrow(
      "cannot be reconciled"
    )
  }
  expect(f.requests.filter((r) => r.url.endsWith("/episodic"))).toHaveLength(1)
})
test("live validation workflow works against the SDK transport for both modes", async () => {
  const { validateLive } = await import("./validate")
  for (const ProviderClass of [AtlasAgentEngineDirectProvider, AtlasAgentEngineProvider]) {
    const f = await fixture()
    const logs: string[] = []
    await validateLive(
      () => new ProviderClass(f.deps),
      { apiKey: "", baseUrl: "http://localhost:8000" },
      (message) => {
        logs.push(message)
      }
    )
    expect(logs.at(-1)).toContain("Passed")
  }
})
test("empty sessions do not write or wait", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([{ sessionId: "empty", messages: [] }], { containerTag: "run" })
  expect(result.documentIds).toEqual([])
  await p.awaitIndexing(result, "run")
  expect(f.requests).toHaveLength(0)
})

test("turn replay reuses the SDK idempotency key after an uncertain response", async () => {
  const f = await fixture()
  const keys: string[] = []
  let accepted: unknown
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    keys.push(body.idempotency_key)
    if (!accepted) {
      accepted = await (await f.deps.fetchImpl(url, init)).json()
      return Response.json({ detail: "lost acknowledgement" }, { status: 500 })
    }
    return Response.json(accepted)
  }
  const first = new AtlasAgentEngineProvider({ ...f.deps, fetchImpl })
  await first.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  await expect(first.ingest([session], { containerTag: "run" })).rejects.toThrow("HTTP 500")
  const resumed = new AtlasAgentEngineProvider({ ...f.deps, fetchImpl })
  await resumed.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  await resumed.ingest([session], { containerTag: "run" })
  expect(keys).toHaveLength(2)
  expect(keys[0]).toHaveLength(64)
  expect(keys[1]).toBe(keys[0])
  expect(f.episodes).toHaveLength(1)
})

test("verbose readiness logs explain grace and stability waits without transcript content", async () => {
  const f = await fixture()
  const p = new AtlasAgentEngineProvider(f.deps)
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest([session], { containerTag: "diagnostic-run" })
  const output = spyOn(console, "log").mockImplementation(() => {})
  logger.setVerbosity(2)
  try {
    await p.awaitIndexing(result, "diagnostic-run")
    const logs = output.mock.calls.flat().join("\n")
    expect(logs).toContain('"grace":1')
    expect(logs).toContain('"stability":1')
    expect(logs).toContain("Checking session searchability")
    expect(logs).toContain('"searchable":true')
    expect(logs).toContain("Readiness checks passed")
    expect(logs).not.toContain("Source date:")
  } finally {
    logger.setVerbosity(0)
    output.mockRestore()
  }
})

test("direct ingest diagnostics time writes and report reused receipts without content", async () => {
  const f = await fixture()
  const p = await f.create()
  const output = spyOn(console, "log").mockImplementation(() => {})
  logger.setVerbosity(2)
  try {
    await p.ingest([session], { containerTag: "ingest-diagnostic" })
    await p.ingest([session], { containerTag: "ingest-diagnostic" })
    const logs = output.mock.calls.flat().join("\n")
    expect(logs).toContain("Remote write started")
    expect(logs).toContain("Remote write completed")
    expect(logs).toContain("Save receipt manifest completed")
    expect(logs).toContain('"written":1')
    expect(logs).toContain('"reused":1')
    expect(logs).toContain('"durationMs":')
    expect(logs).not.toContain("Source date:")
    expect(f.episodes).toHaveLength(1)
  } finally {
    logger.setVerbosity(0)
    output.mockRestore()
  }
})

test("direct ingestion proceeds to indexing and search with null server embeddings", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([session], { containerTag: "null-embedding" })
  f.episodes[0].embedding = null
  await p.awaitIndexing(result, "null-embedding")
  expect(await p.search("airport", { containerTag: "null-embedding" })).toHaveLength(1)
})

test("invalid search responses report validation errors without exposing response content", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([session], { containerTag: "invalid-embedding" })
  f.episodes[0].embedding = "sensitive-invalid-value"
  await expect(p.awaitIndexing(result, "invalid-embedding")).rejects.toThrow(
    "response validation failed"
  )
  try {
    await p.search("airport", { containerTag: "invalid-embedding" })
    throw new Error("Expected search failure")
  } catch (error) {
    expect(String(error)).toContain("response validation failed")
    expect(String(error)).not.toContain("sensitive-invalid-value")
    expect(String(error)).not.toContain("HTTP network")
  }
})

test("direct indexing publishes progress before the full episode scan finishes", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest(
    [session, { ...session, sessionId: "s2" }, { ...session, sessionId: "s3" }],
    { containerTag: "incremental-index" }
  )
  const observed: { completed: number; searches: number }[] = []
  await p.awaitIndexing(result, "incremental-index", (progress) => {
    observed.push({
      completed: progress.completedIds.length,
      searches: f.requests.filter((r) => r.url.endsWith("/search")).length,
    })
  })
  expect(observed[0]).toEqual({ completed: 1, searches: 1 })
  expect(observed[1]).toEqual({ completed: 2, searches: 2 })
  expect(observed.at(-1)).toEqual({ completed: 3, searches: 3 })
})

test("direct indexing reports checks even when episodes are not searchable", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest([session, { ...session, sessionId: "s2" }], {
    containerTag: "pending-index",
  })
  f.hide()
  const observed: number[] = []
  await expect(
    p.awaitIndexing(result, "pending-index", (progress) => {
      expect(progress.completedIds).toHaveLength(0)
      observed.push(f.requests.filter((r) => r.url.endsWith("/search")).length)
    })
  ).rejects.toThrow("timed out")
  expect(observed[0]).toBe(1)
})

test("direct readiness credits all returned receipts from the requested session", async () => {
  const f = await fixture()
  const p = await f.create()
  const result = await p.ingest(
    [{ ...session, messages: Array.from({ length: 20 }, () => session.messages[0]) }],
    { containerTag: "shared-hits" }
  )
  await p.awaitIndexing(result, "shared-hits")
  expect(f.requests.filter((r) => r.url.endsWith("/search"))).toHaveLength(1)
})

test("readiness still queries missing hits and does not credit other sessions", async () => {
  const f = await fixture()
  let searches = 0
  const p = new AtlasAgentEngineDirectProvider({
    ...f.deps,
    fetchImpl: async (url, init) => {
      const response = await f.deps.fetchImpl(url, init)
      if (!url.endsWith("/search")) return response
      searches++
      // Simulate a truncated first response containing an unrelated session's hit.
      if (searches === 1) return Response.json({ memories: [f.episodes[0], f.episodes[2]] })
      return response
    },
  })
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest(
    [
      { ...session, messages: [session.messages[0], session.messages[0]] },
      { ...session, sessionId: "s2" },
    ],
    { containerTag: "partial-hits" }
  )
  const completed: number[] = []
  await p.awaitIndexing(result, "partial-hits", (progress) =>
    completed.push(progress.completedIds.length)
  )
  expect(completed[0]).toBe(1)
  expect(searches).toBe(3)
  expect(completed.at(-1)).toBe(3)
})

test("extraction publishes session readiness before a later session check finishes", async () => {
  const f = await fixture()
  const snapshots: import("../../types/provider").IndexingProgress[] = []
  let observedPartial = false
  const p = new AtlasAgentEngineProvider({
    ...f.deps,
    fetchImpl: async (url, init) => {
      if (url.includes("/episodic?") && f.time() >= 241000) {
        const latest = snapshots.at(-1)
        if (latest?.readiness?.checkingSession === "s2") {
          expect(latest.completedIds).toHaveLength(1)
          expect(latest.readiness.readySessions).toBe(1)
          observedPartial = true
        }
      }
      return f.deps.fetchImpl(url, init)
    },
  })
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest([session, { ...session, sessionId: "s2" }], { containerTag: "run" })
  await p.awaitIndexing(result, "run", (progress) => snapshots.push(progress))
  expect(observedPartial).toBe(true)
  expect(snapshots.some((p) => p.readiness?.waiting.grace === 2)).toBe(true)
  expect(snapshots.some((p) => p.readiness?.waiting.stability === 2)).toBe(true)
  expect(snapshots.at(-1)?.readiness?.readySessions).toBe(2)
  expect(
    snapshots
      .filter((p) => Date.parse(p.readiness!.checkedAt) < 241000)
      .every((p) => p.completedIds.length === 0)
  ).toBe(true)
})

test("extraction revokes earlier readiness if episodes disappear during a later scan", async () => {
  const f = await fixture()
  const p = new AtlasAgentEngineProvider(f.deps)
  await p.initialize({ apiKey: "", baseUrl: "http://localhost:8000" })
  const result = await p.ingest([session, { ...session, sessionId: "missing" }], {
    containerTag: "run",
  })
  f.episodes.pop()
  let hadReady = false
  let revoked = false
  await expect(
    p.awaitIndexing(result, "run", (progress) => {
      if (progress.completedIds.length) {
        hadReady = true
        f.episodes.splice(0)
      } else if (hadReady && progress.readiness?.waiting.episodes === 2) revoked = true
    })
  ).rejects.toThrow("readiness timed out")
  expect(hadReady).toBe(true)
  expect(revoked).toBe(true)
})
