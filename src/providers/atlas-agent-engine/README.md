# Atlas Agent Engine

`atlas-agent-engine-direct` writes private episodic memories using the public JavaScript SDK, pinned to 0.11.7. Transcripts retain roles, speakers and available message dates. Direct writes use chunks of at most 1,600 Unicode code points with 320 points of overlap.

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
