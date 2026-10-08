import { afterEach, expect, test } from "bun:test"
import { Mem0LocalProvider } from "./index"
import { createProvider, getAvailableProviders } from "../index"
import { getProviderConfig } from "../../utils/config"
import { sourceMessages } from "../../utils/source-message"
import type { UnifiedSession } from "../../types/unified"

const session: UnifiedSession = {
  sessionId: "session-1",
  metadata: { date: "2023-05-08T13:56:00.000Z" },
  messages: [
    { role: "user", speaker: "Alice", content: "I went to Paris yesterday." },
    { role: "user", speaker: "Bob", content: "I live in London." },
  ],
}
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

test("registered local provider completes an isolated REST lifecycle with source parity", async () => {
  const requests: { path: string; method: string; key: string | null; body: any }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json() : undefined
      requests.push({
        path: url.pathname + url.search,
        method: req.method,
        key: req.headers.get("X-API-Key"),
        body,
      })
      if (url.pathname === "/memories" && req.method === "POST")
        return Response.json({
          results: [{ id: "one", event: "ADD", memory: "Alice visited Paris" }],
        })
      if (url.pathname === "/search")
        return Response.json({
          results: [
            { id: "one", memory: "Alice visited Paris", score: 0.9, metadata: session.metadata },
          ],
          relations: [{ source: "Alice" }],
        })
      if (req.method === "DELETE")
        return Response.json({ message: "All relevant memories deleted" })
      return new Response(null, { status: 404 })
    },
  })
  servers.push(server)
  expect(getAvailableProviders()).toContain("mem0-local")
  const provider = createProvider("mem0-local")
  await provider.initialize({ apiKey: "local-test-key", baseUrl: server.url.origin })
  const receipt = await provider.ingest([session], { containerTag: "question/run & 1" })
  expect(receipt).toEqual({ documentIds: ["one"] })
  let progress: unknown
  await provider.awaitIndexing(receipt, "question/run & 1", (value) => {
    progress = value
  })
  expect(progress).toEqual({ completedIds: ["one"], failedIds: [], total: 1 })
  const results = await provider.search("Where?", { containerTag: "question/run & 1", limit: 10 })
  expect(results).toHaveLength(1)
  await provider.clear("question/run & 1")
  expect(requests).toHaveLength(3) // No configure, cloud project update, or event polling.
  expect(requests.every((r) => r.key === "local-test-key")).toBe(true)
  expect(requests[0].body).toEqual({
    messages: sourceMessages(session),
    user_id: "question/run & 1",
    infer: true,
    metadata: {
      ...session.metadata,
      sessionId: session.sessionId,
      timestamp: session.metadata!.date,
    },
  })
  expect(requests[1].body).toEqual({ query: "Where?", user_id: "question/run & 1", limit: 10 })
  expect(new URL(requests[2].path, server.url).searchParams.get("user_id")).toBe("question/run & 1")
  expect(provider.readinessPolicy).toEqual({
    method: "synchronous-response",
    extractionCompletionConfirmed: false,
  })
  expect(provider.concurrency).toEqual({ default: 2 })
})

test("optional authentication, namespace scoping, and configured base paths", async () => {
  const seen: string[] = []
  const provider = new Mem0LocalProvider(async (url, init) => {
    expect(new Headers(init.headers).has("X-API-Key")).toBe(false)
    expect(url.pathname).toBe("/api/search")
    seen.push(JSON.parse(String(init.body)).user_id)
    return Response.json({ results: [] })
  })
  await provider.initialize({ apiKey: "", baseUrl: "http://localhost:8888/api" })
  await provider.search("q", { containerTag: "a" })
  await provider.search("q", { containerTag: "b" })
  expect(seen).toEqual(["a", "b"])
  await expect(provider.clear(" ")).rejects.toThrow("container tag")
  expect(await provider.search("q", { containerTag: "a", limit: 0 })).toEqual([])
  expect(seen).toHaveLength(2)
})

test("empty extraction and update/delete operations do not become job IDs", async () => {
  let next: unknown = { results: [] }
  const provider = new Mem0LocalProvider(async () => Response.json(next))
  await provider.initialize({ apiKey: "" })
  expect(await provider.ingest([session], { containerTag: "a" })).toEqual({ documentIds: [] })
  next = {
    results: [
      { id: "a", event: "ADD" },
      { id: "a", event: "UPDATE" },
      { id: "b", event: "DELETE" },
    ],
  }
  expect(await provider.ingest([session], { containerTag: "a" })).toEqual({ documentIds: ["a"] })
})

test("malformed responses and HTTP errors fail explicitly without leaking bodies", async () => {
  for (const response of [
    new Response("private server details", { status: 401 }),
    new Response("private server details", { status: 500 }),
    new Response("not json"),
    Response.json({}),
    Response.json({ results: [null] }),
    Response.json({ results: [{ id: "a" }] }),
  ]) {
    const provider = new Mem0LocalProvider(async () => response)
    await provider.initialize({ apiKey: "" })
    try {
      await provider.search("q", { containerTag: "a" })
      throw new Error("unexpected success")
    } catch (error) {
      expect(String(error)).toContain("Mem0 local")
      expect(String(error)).not.toContain("private server details")
    }
  }
  const provider = new Mem0LocalProvider(async () =>
    Response.json({ results: [{ event_id: "cloud" }] })
  )
  await provider.initialize({ apiKey: "" })
  await expect(provider.ingest([session], { containerTag: "a" })).rejects.toThrow(
    "invalid memory operation"
  )
})

test("timed out writes are not automatically retried", async () => {
  let calls = 0
  const provider = new Mem0LocalProvider(async (_url, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  })
  await provider.initialize({ apiKey: "", timeoutMs: 10 })
  await expect(provider.ingest([session], { containerTag: "a" })).rejects.toThrow(
    "a write may have completed"
  )
  expect(calls).toBe(1)
})

test("configuration rejects embedded credentials and invalid timeouts", async () => {
  const provider = new Mem0LocalProvider()
  await expect(
    provider.initialize({ apiKey: "", baseUrl: "http://user:secret@localhost" })
  ).rejects.toThrow("without credentials")
  await expect(provider.initialize({ apiKey: "", timeoutMs: -1 })).rejects.toThrow("timeoutMs")
  expect(getProviderConfig("mem0-local").baseUrl).toBe(
    process.env.MEM0_LOCAL_BASE_URL || "http://localhost:8888"
  )
})
