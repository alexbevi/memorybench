# Atlas Agent Engine

Two providers use the public JavaScript SDK, pinned to 0.11.7:

| Provider | Ingestion | Search |
| --- | --- | --- |
| `atlas-agent-engine` | Records nonempty conversation turns; the service extracts memories in the background. | Semantic and episodic memories. |
| `atlas-agent-engine-direct` | Writes transcript chunks as private episodic memories. | Episodic memories. |

Both submit roles, speakers and available source dates. Direct mode splits messages into at most 1,600 Unicode code points with 320 points of overlap, then adds role, speaker and date context to each fragment. It preserves all message text. Extraction submits original turns, which may exceed server limits.

## Connection

For a local service, follow the [standalone memory service guide](https://www.mongodb.com/docs/agentengine/add-features/memory-only/). Set `AGENTIC_MEMORY_BASE_URL` to its `oe` URL. Unset `AGENTIC_MEMORY_PROJECT_ID`, `AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN` and the deprecated `AGENTIC_MEMORY_API_KEY`.

For hosted service, set `AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN` and `AGENTIC_MEMORY_PROJECT_ID`. Leave `AGENTIC_MEMORY_BASE_URL` unset. Obtain and refresh the token outside MemoryBench using the [authentication guide](https://www.mongodb.com/docs/agentengine/add-features/memory-only/) and [SDK configuration](https://www.mongodb.com/docs/agentengine/sdk/javascript/packages/agent-engine-memory/). Token rotation preserves receipts; restart the process to load a refreshed token.

MemoryBench's answering and judge credentials are separate from the service's extraction and embedding configuration. Record the server version, extraction model, embedding model and deployment mode with results. Context-token metrics exclude server extraction costs.

## Validate and run

From the repository root, after configuring a connection:

```sh
bun install --frozen-lockfile
bun test src/providers/atlas-agent-engine src/orchestrator/phases/ingest.test.ts
bun node_modules/typescript/bin/tsc --noEmit

# Validate configuration without contacting the service.
bun src/providers/atlas-agent-engine/validate.ts

# Create persistent test records and check readiness, retrieval and isolation.
bun src/providers/atlas-agent-engine/validate.ts --provider atlas-agent-engine-direct --live
bun src/providers/atlas-agent-engine/validate.ts --provider atlas-agent-engine --live
```

Live validation also checks receipt reuse. Extraction can take several minutes. Keep the printed scope and user IDs if validation fails; the validator cannot clean up remote records. Offline tests use the real SDK with a fake transport and cannot verify a deployed service's extraction or embedding configuration.

After preparing benchmark data and model credentials:

```sh
bun run src/index.ts run -p atlas-agent-engine-direct -b locomo -l 1 -r atlas-direct-smoke --concurrency 1
bun run src/index.ts run -p atlas-agent-engine -b locomo -l 1 -r atlas-extraction-smoke --concurrency 1

# Resume after a service issue or token refresh.
bun run src/index.ts run -r atlas-extraction-smoke

# Compare both modes on the same questions.
bun run src/index.ts compare -p atlas-agent-engine,atlas-agent-engine-direct -b locomo -l 5 --compare-id atlas-comparison
```

## Indexing progress

Direct mode checks that each saved chunk is searchable. Extraction mode waits at least 180 seconds after a session's last write, then requires a searchable episode and 60 seconds of unchanged episode contents. Both time out after 15 minutes; resume to retry.

Extraction readiness is a heuristic. The SDK exposes no extraction-complete signal, and a session that produces no episode will time out. Probes use source text, never benchmark questions or answers.

The UI counts ready ingestion receipts. In extraction mode, a receipt represents a recorded turn, so this count is not the number of extracted episodes. Session progress shows what is waiting for the minimum delay, episode availability, searchability or stability. Counts can decrease when a later check invalidates readiness.

Session checks run sequentially within each question, with five seconds between scans. Indexing concurrency controls simultaneous questions; the default is two. A slow service request can delay progress updates.

## Retrieval and answering

Results are deduplicated by source and ID, ranked by score and capped at the requested limit. If a similarity threshold is supplied, the adapter applies it locally and excludes results without scores. It does not refill filtered results. Scores are not calibrated across providers or memory types.

Answers use MemoryBench's [shared prompt and context budget](../../prompts/answer.ts). Atlas results include content, memory type, score and available provenance. Service timestamps are not treated as event dates. Extraction may lose source dates or session provenance; the adapter does not fetch original transcripts to fill gaps.

The SDK search calls used here expose no hybrid-search or reranker controls. Direct mode provides a separate transcript-retrieval baseline.

## Resume and recovery

Keep `data/atlas-agent-engine/` together with run checkpoints. Manifests contain source text and need the same access controls as benchmark data. A checkpoint alone cannot support safe write recovery.

Each accepted write is saved atomically. Turn keys are deterministic; uncertain direct writes are reconciled through session-scoped listing before retrying. Reconciliation refuses ambiguous matches and saturated 1,000-entry listings. Preserve the files and inspect service data if reconciliation fails.

Provider name and container tag determine remote identities. Use a new run ID when changing source sessions or the service connection. Resume also requires matching code and dataset provenance. Tokens are never stored in manifests.

An interrupted process can leave a `.lock` file beside a manifest. Stop all writers to that scope before removing it.

| Failure | Check |
| --- | --- |
| HTTP 401/403 | Token validity and project access. |
| HTTP 404 | Hosted project ID, or stray token/project settings in local mode. |
| HTTP 400/413 | Server limits, especially oversized extraction turns. |
| HTTP 429 | Reduce concurrency before resuming. |
| Unavailable runtime | Service provisioning. |
| Indexing timeout | Embedding configuration, extraction workers and service logs. |

The SDK retries selected transient transport failures. Direct episode creation is not automatically retried. Adapter errors omit response bodies to avoid exposing credentials.

## Stop and cleanup

**Stop local work** stops ingestion before the next session upload and readiness polling at the next progress callback. Other phases finish their in-flight batch. Requests already sent to the service may finish.

`POST /api/runs/:runId/stop` accepts `{"scope":"local"}` or an empty body. Scopes `remote` and `all` return HTTP 409 without stopping local work. The adapters expose no remote cancellation operation.

Stopping or deleting a run does not cancel remote extraction or delete service data. Neither `--force` nor a new run ID clears the service. `clear()` throws because the SDK cannot delete a complete user scope.

Abandoned runs can keep consuming worker capacity. Remote cleanup must account for running jobs and retained turns that can regenerate queued work; deleting queue rows alone is insufficient.
