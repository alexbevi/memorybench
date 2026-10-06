# Atlas Agent Engine

`atlas-agent-engine-direct` writes private episodic memories using the public JavaScript SDK, pinned to 0.11.7. Transcripts retain roles, speakers and available message dates. Direct writes split each message into chunks of at most 1,600 Unicode code points with 320 points of overlap, then prepend role, speaker and date context to every fragment. No message text is truncated.

## Local configuration

Follow the [standalone memory service guide](https://www.mongodb.com/docs/agentengine/add-features/memory-only/) to start the local service. Set only `AGENTIC_MEMORY_BASE_URL` to its `oe` URL. Unset `AGENTIC_MEMORY_PROJECT_ID`, `AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN` and the deprecated `AGENTIC_MEMORY_API_KEY`.

## Validation and recovery

Run `bun test src/providers/atlas-agent-engine` and `bun node_modules/typescript/bin/tsc --noEmit` from the repository root.

Receipts live in `data/atlas-agent-engine/`. Keep this directory with benchmark checkpoints when resuming. Remote identity hashes include provider name and container tag, isolating runs and variants. Changing a session or service connection requires a new run ID. Each accepted write is saved atomically. An uncertain episode write is reconciled through session-scoped listing before proceeding; it is never blindly recreated. If reconciliation cannot prove one matching episode, inspect remote data or use a new run ID.

Indexing polls source-derived text for each episode for up to 15 minutes. Timeout fails the phase so a later resume can try again. Acknowledged writes alone do not prove vector search readiness.

`clear()` throws because this SDK cannot delete a complete user scope. New run IDs and `--force` do not remove service data. Interrupted processes can leave a `.lock` file beside a manifest. Stop all writers to that scope before manually removing its lock.

## Conversation extraction

`atlas-agent-engine` records the original nonempty turns with deterministic idempotency keys. The service extracts memories in the background. Search requests semantic and episodic memories across the container's sessions. No benchmark questions or answers are used for readiness probes.

Readiness waits at least three minutes after the last turn, then requires each session to have a searchable episode and an unchanged episode listing for one minute. It times out after 15 minutes. This is an observation heuristic, not proof that all semantic extraction has finished. Sessions for which the service creates no episode will time out even if that behavior is valid. Direct mode avoids background extraction and offers a separate baseline.

## Hosted configuration

Set `AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN` and `AGENTIC_MEMORY_PROJECT_ID`. Leave `AGENTIC_MEMORY_BASE_URL` unset to use the hosted gateway. These are the SDK's own variables; the adapter has no client ID or client secret settings.

Create the service account and exchange its credentials for an access token outside MemoryBench, following the [Atlas authentication instructions](https://www.mongodb.com/docs/agentengine/add-features/memory-only/) and [JavaScript SDK configuration](https://www.mongodb.com/docs/agentengine/sdk/javascript/packages/agent-engine-memory/). Refresh an expired token and resume the same run in a new process. Tokens are not written to manifests, and token rotation does not invalidate receipts.

HTTP 401/403 means check the token and project access. For 404, verify that a hosted project ID is present or that local configuration has neither token nor project ID. Check service provisioning for unavailable-runtime errors. For 429, reduce benchmark concurrency and resume. The SDK handles selected transient transport failures; direct episode creation is not automatically retried. Response bodies are omitted from adapter error messages to avoid exposing credentials.

## Retrieval and answering

The adapter applies the benchmark's similarity threshold locally because the SDK does not forward that setting for semantic or episodic searches. Missing scores are excluded when a threshold is requested. Results are deduplicated by source and ID, ranked by score, and capped by the requested limit. Filtering can return fewer results; the adapter does not issue refill queries. Scores are not calibrated across providers or memory types.

Answer context includes content, memory type, score and available source provenance. Embeddings and arbitrary metadata are omitted. The answer prompt distinguishes source dates from service record timestamps and handles conflicting evidence. The default benchmark judge remains unchanged.

Session dates are retained in submitted text and direct episode metadata. Conversation extraction can lose source dates or session provenance; the adapter does not invent them or fetch original transcripts to supplement extraction results.

## Test against your service

Run these from the repository root after configuring one connection mode above:

```sh
bun install --frozen-lockfile
bun test src/providers/atlas-agent-engine src/orchestrator/phases/ingest.test.ts
bun node_modules/typescript/bin/tsc --noEmit

# Checks configuration only, without making a service request.
bun src/providers/atlas-agent-engine/validate.ts

# These create persistent remote records, with printed scope and user IDs.
bun src/providers/atlas-agent-engine/validate.ts --provider atlas-agent-engine-direct --live
bun src/providers/atlas-agent-engine/validate.ts --provider atlas-agent-engine --live
```

Live validation writes two sessions and a separate container with conflicting facts. It checks readiness, receipt reuse after constructing a new provider, retrieval across both sessions, allowed memory sources and container isolation. Extraction validation can take several minutes. If it fails, retain the printed identifiers and manifests for investigation. The test deliberately does not attempt unsupported cleanup.

Offline tests exercise the real SDK through a fake HTTP transport. They verify route selection, authorization, persistent resume, uncertain write reconciliation, timeout behavior, chunk coverage and normalization. They do not verify a deployed server's response shape, extraction quality or embedding configuration. The pinned SDK declares Node.js 24 or newer; these adapter tests also run under Bun 1.3.4. Live verification is still required for your deployment.

### Benchmark smoke tests

MemoryBench also needs its usual answering and judge model credentials. Those are separate from the memory service's server-side embedding and extraction configuration. Prepare benchmark data using the repository's normal setup.

```sh
bun run src/index.ts run -p atlas-agent-engine-direct -b locomo -l 1 -r atlas-direct-smoke --concurrency 1
bun run src/index.ts run -p atlas-agent-engine -b locomo -l 1 -r atlas-extraction-smoke --concurrency 1

# Resume the existing run after a service issue or token refresh.
bun run src/index.ts run -r atlas-extraction-smoke

# Use the same selected questions to compare the two modes.
bun run src/index.ts compare -p atlas-agent-engine,atlas-agent-engine-direct -b locomo -l 5 --compare-id atlas-comparison

# Exercise larger transcripts after the LoCoMo smoke tests pass.
bun run src/index.ts run -p atlas-agent-engine-direct -b longmemeval -l 1 -r atlas-long-smoke --concurrency 1

# Choose a question ID from that run's checkpoint; this reuses ingested data.
bun run src/index.ts test -r atlas-direct-smoke -q QUESTION_ID
```

Use a new run ID for a fresh dataset or connection. Keep both the run checkpoint and `data/atlas-agent-engine/` for resume. Ingestion flushes each completed session's receipt before starting the next session. Manifests contain source text and should receive the same access controls as benchmark data. Copying a checkpoint alone is insufficient. A lost manifest makes safe write reconciliation unavailable.

## Parity and known gaps

| Capability | Adapter behavior and remaining gap |
| --- | --- |
| Resumable ingestion | Persistent per-write receipts, deterministic turn keys and reconciliation of uncertain direct writes. SDK listing has no pagination; reconciliation refuses a saturated 1,000-entry listing. |
| Isolation | Private memories with user IDs derived from provider and container tag, and stable per-session IDs. Hosted projects add a service boundary. This is benchmark namespacing, not a replacement for service authorization. |
| Long transcripts | Direct mode chunks messages without truncation. Extraction preserves original turns; an oversized turn may be rejected by the server. Check server limits on 400/413 responses. |
| Dates and provenance | Roles, speakers and available dates are submitted. Direct fragments repeat context. Extracted memories may omit provenance; service timestamps are never treated as event dates. |
| Search quality | Uses SDK semantic/episodic vector retrieval. The chosen SDK calls expose no hybrid-search or reranker controls comparable to RAG's BM25 fusion or Zep's reranking. |
| Source expansion | No automatic raw-transcript expansion alongside extracted facts, unlike providers with source-chunk retrieval. Direct mode measures transcript retrieval separately. |
| Readiness | Direct mode checks each saved chunk. Extraction checks each nonempty session using the documented heuristic above. The public SDK exposes no extraction job status or complete signal. |
| Cleanup | Full-scope deletion is unavailable through the public JavaScript SDK. `clear()` fails explicitly. `--force`, deleting manifests and choosing a new run do not delete remote data. |
| Throughput and cancellation | Writes are sequential within a session; SDK bulk writes are unavailable. Default question concurrency is two. The existing provider interface has no abort signal; an in-flight SDK request may delay stopping. |
| Authentication | The caller supplies and refreshes the hosted token. Automatic OAuth exchange and token renewal are outside the adapter. |
| Evaluation | Provider-specific answer prompt and default benchmark judge. Zep's custom judge differs, so record judge/prompt choices when interpreting comparisons. |
| Cost and reproducibility | Record server version, extraction model, embedding model, deployment mode and SDK version with results. MemoryBench's context-token metrics do not include the server's extraction costs. |

For indexing timeouts, check embedding configuration, extraction workers and service logs, then resume. A nonempty conversation may legitimately yield no episode; this adapter conservatively fails readiness in that case. For corrupted manifests, preserve the files and investigate before retrying. A fresh run avoids reusing uncertain receipts but leaves previous remote data intact.

See [Agent Memory](https://www.mongodb.com/docs/agentengine/add-features/memory-types/#std-label-agentic-platform-memory), the [JavaScript SDK overview](https://www.mongodb.com/docs/agentengine/sdk/javascript/), and the [memory package source](https://github.com/mongodb/agent-engine-client-libraries/tree/main/javascript/packages/agent-engine-memory) for service behavior and SDK capabilities.
