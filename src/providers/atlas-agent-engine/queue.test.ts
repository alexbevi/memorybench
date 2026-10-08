import { expect, test } from "bun:test"
import { readAtlasQueue } from "./queue"
import { observeQueue } from "../../orchestrator/queue"
test("queue routes and authentication match local and hosted deployments", async () => {
  for (const projectId of ["", "project"]) {
    const result = await readAtlasQueue(
      {
        baseUrl: "https://example.test",
        projectId,
        serviceAccountToken: projectId ? "secret" : undefined,
      },
      (async (url, init) => {
        expect(String(url)).toBe(
          projectId
            ? "https://example.test/api/v1/projects/project/memory/queueStats"
            : "https://example.test/api/v1/memory/worker/queueStats"
        )
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          projectId ? "Bearer secret" : null
        )
        return Response.json({ queued: 4, running: 2, failed: 1 })
      })
    )
    expect(result.status).toBe("available")
  }
})
test("unsupported, errors and invalid counts never become a zero queue", async () => {
  const c = { baseUrl: "http://localhost", projectId: "", serviceAccountToken: undefined }
  for (const payload of [
    { queued: -1, running: 0, failed: 0 },
    { queued: "0", running: 0, failed: 0 },
    { queued: 0 },
    null,
  ])
    expect(
      (await readAtlasQueue(c, (async () => Response.json(payload)))).status
    ).toBe("unavailable")
  for (const status of [404, 503, 401])
    expect(
      (await readAtlasQueue(c, (async () => new Response("secret", { status }))))
        .status
    ).toBe(status === 404 ? "unsupported" : "unavailable")
  expect((await observeQueue({})).status).toBe("unsupported")
})
