# Atlas Agent Engine

`atlas-agent-engine-direct` writes private episodic memories using the public JavaScript SDK, pinned to 0.11.7. Transcripts retain roles, speakers and available message dates. Direct writes use chunks of at most 1,600 Unicode code points with 320 points of overlap.

## Local configuration

Follow the [standalone memory service guide](https://www.mongodb.com/docs/agentengine/add-features/memory-only/) to start the local service. Set only `AGENTIC_MEMORY_BASE_URL` to its `oe` URL. Unset `AGENTIC_MEMORY_PROJECT_ID`, `AGENTIC_MEMORY_SERVICE_ACCOUNT_TOKEN` and the deprecated `AGENTIC_MEMORY_API_KEY`.

## Validation and recovery

Run `bun test src/providers/atlas-agent-engine` and `bun node_modules/typescript/bin/tsc --noEmit` from the repository root.

Receipts live in `data/atlas-agent-engine/`. Keep this directory with benchmark checkpoints when resuming. Remote identity hashes include provider name and container tag, isolating runs and variants. Changing a session or service connection requires a new run ID. Each accepted write is saved atomically. An uncertain episode write is reconciled through session-scoped listing before proceeding; it is never blindly recreated. If reconciliation cannot prove one matching episode, inspect remote data or use a new run ID.

Indexing polls source-derived text for each episode for up to 15 minutes. Timeout fails the phase so a later resume can try again. Acknowledged writes alone do not prove vector search readiness.

`clear()` throws because this SDK cannot delete a complete user scope. New run IDs and `--force` do not remove service data. Interrupted processes can leave a `.lock` file beside a manifest. Stop all writers to that scope before manually removing its lock.
