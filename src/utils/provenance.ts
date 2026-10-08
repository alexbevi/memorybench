import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import type { Benchmark } from "../types/benchmark"
import type { ProviderConfig } from "../types/provider"
import { ANSWER_POLICY_VERSION } from "../prompts/answer"

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
function codeSnapshot() {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const files = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "src", "package.json", "bun.lock"],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
    const hash = createHash("sha256")
    for (const file of [...new Set(files)].sort()) {
      hash.update(file)
      hash.update(readFileSync(file))
    }
    return {
      revision,
      sourceHash: hash.digest("hex"),
      dirty: Boolean(
        execFileSync("git", ["status", "--porcelain", "--", "src", "package.json", "bun.lock"], {
          encoding: "utf8",
        }).trim()
      ),
    }
  } catch {
    return { revision: "unavailable", sourceHash: "unavailable", dirty: true }
  }
}
// Capture when the server imports this module, not when a later request arrives.
export const PROCESS_PROVENANCE = {
  ...codeSnapshot(),
  startedAt: new Date().toISOString(),
  runtime: `bun ${Bun.version}`,
}

export function datasetHash(benchmark: Benchmark): string {
  const hash = createHash("sha256")
  const seen = new Set<string>()
  for (const question of benchmark.getQuestions()) {
    hash.update(JSON.stringify(question))
    for (const session of benchmark.getHaystackSessions(question.questionId)) {
      const signature = digest(session)
      if (!seen.has(signature)) {
        seen.add(signature)
        hash.update(signature)
      }
    }
  }
  return hash.digest("hex")
}
export function publicProviderConfig(config: ProviderConfig) {
  let endpoint: string | undefined
  try {
    if (config.baseUrl) endpoint = new URL(config.baseUrl).origin
  } catch {
    endpoint = "invalid"
  }
  return {
    endpoint,
    projectId: typeof config.projectId === "string" ? config.projectId : undefined,
  }
}
export interface RunProvenance {
  code: typeof PROCESS_PROVENANCE
  datasetHash: string
  selectedQuestionIds: string[]
  answerPolicy: string
  inputPolicy: string
  retrievalPolicy: string
  providerConfig: ReturnType<typeof publicProviderConfig>
  localAtlasConfigHash?: string
  measurement: string
}
export function captureProvenance(
  benchmark: Benchmark,
  ids: string[],
  config: ProviderConfig
): RunProvenance {
  let localAtlasConfigHash: string | undefined
  try {
    localAtlasConfigHash = digest(
      readFileSync("self-hosted/agent-engine/memorybench/project-config.yaml", "utf8")
    )
  } catch {}
  return {
    code: PROCESS_PROVENANCE,
    datasetHash: datasetHash(benchmark),
    selectedQuestionIds: [...ids],
    answerPolicy: ANSWER_POLICY_VERSION,
    inputPolicy: "named-personas-v1",
    retrievalPolicy: "native-top10-v1",
    providerConfig: publicProviderConfig(config),
    localAtlasConfigHash,
    measurement: "single-search-after-readiness; cache-state-uncontrolled",
  }
}
