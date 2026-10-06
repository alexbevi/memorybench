import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AtlasAgentEngineDirectProvider, TIMEOUT_MS } from "./index"
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
