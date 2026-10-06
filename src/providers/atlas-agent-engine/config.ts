import type { ProviderConfig } from "../../types/provider"

export function connectionOptions(config: ProviderConfig) {
  if (process.env.AGENTIC_MEMORY_API_KEY)
    throw new Error(
      "Unset deprecated AGENTIC_MEMORY_API_KEY; use AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN for hosted Atlas."
    )
  const token = config.apiKey || process.env.AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN
  const projectId = String(config.projectId ?? process.env.AGENTIC_MEMORY_PROJECT_ID ?? "").trim()
  if (Boolean(token) !== Boolean(projectId))
    throw new Error(
      "Hosted Atlas requires both AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN and AGENTIC_MEMORY_PROJECT_ID. Local connections require neither."
    )
  const address =
    config.baseUrl ||
    process.env.AGENTIC_MEMORY_BASE_URL ||
    (token ? "https://agentengine.mongodb.com" : "")
  if (!address)
    throw new Error(
      "Set AGENTIC_MEMORY_BASE_URL to the local oe URL, or configure a hosted token and project ID."
    )
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error("Atlas base URL is invalid.")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "Atlas base URL must be an HTTP(S) origin without credentials, path, query, or fragment."
    )
  if (token && url.protocol !== "https:") throw new Error("Hosted Atlas requires HTTPS.")
  return { baseUrl: url.origin, projectId, serviceAccountToken: token }
}
