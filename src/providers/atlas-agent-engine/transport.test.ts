import { expect, test } from "bun:test"
import { compatibleFetch } from "./transport"

test("normalization preserves real vectors, metadata, status and request options", async () => {
  const init = { method: "POST", body: "request", signal: new AbortController().signal }
  const transport = compatibleFetch(async (_url, received) => {
    expect(received).toBe(init)
    return Response.json(
      {
        memories: [
          { id: "one", embedding: null, metadata: { embedding: null } },
          { id: "two", embedding: [0.1, 0.2] },
        ],
      },
      { headers: { "x-request-id": "request-one" } }
    )
  })
  const response = await transport("http://localhost/api/v1/memory/search", init)
  expect(response.status).toBe(200)
  expect(response.headers.get("x-request-id")).toBe("request-one")
  expect(await response.json()).toEqual({
    memories: [
      { id: "one", metadata: { embedding: null } },
      { id: "two", embedding: [0.1, 0.2] },
    ],
  })
})

test("unrelated, failed, and malformed responses pass through unchanged", async () => {
  for (const [path, response] of [
    ["episodic", Response.json({ memories: [{ embedding: null }] })],
    ["search", Response.json({ memories: [{ embedding: null }] }, { status: 500 })],
    ["search", new Response("invalid json")],
  ] as const) {
    const transport = compatibleFetch(async () => response)
    expect(await transport(`http://localhost/api/v1/memory/${path}`, {})).toBe(response)
    expect(response.bodyUsed).toBe(false)
  }
})
