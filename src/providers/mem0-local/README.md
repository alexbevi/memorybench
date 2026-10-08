# Standalone mem0 provider

`mem0-local` connects MemoryBench to the REST server in
[self-hosted/mem0/docker-compose.yml](../../../self-hosted/mem0/docker-compose.yml).
The existing `mem0` provider continues to use mem0 Cloud. Keeping separate IDs
prevents local and cloud configurations from sharing a leaderboard label.

## Start the service

Create `self-hosted/mem0/.env` from the checked-in
[Grove example](../../../self-hosted/mem0/grove.env.example) and set your gateway key.
Keep this service configuration separate from the repository root `.env` used by
MemoryBench. From the repository root:

```sh
self-hosted/mem0/compose.sh up -d --build
```

The API defaults to `http://localhost:8888`. PostgreSQL, history, and Neo4j data
remain in named volumes across recreation. The Compose file mounts the checked-in
startup module and shared extraction instructions, so retain the repository layout.

`OPENAI_API_KEY` and `OPENAI_BASE_URL` configure extraction and, by default,
embeddings. The extraction endpoint must accept chat completions with JSON output.
Changing the endpoint does not
change the configured model names. If your gateway requires the existing model
credential in an additional header, set `MEM0_MODEL_API_KEY_HEADER=api-key`, or
the header name specified by that gateway, before recreating the API container.
The server sends the value of `OPENAI_API_KEY` in that header for extraction and,
when sharing the same endpoint, embeddings. Normal bearer
authentication remains present. Leave this setting empty for direct OpenAI use.
`MEM0_LOCAL_API_KEY` controls authentication to mem0 and does not supply this header.

If the gateway expects a deployment alias instead of the pinned extraction model
name, set `MEM0_EXTRACTION_MODEL`, for example `gpt-4.1-nano`. An empty value retains
the pinned default. This does not change the embedding model or vector dimensions.
Record the alias and its actual deployed model version with benchmark results.

## Grove with Voyage embeddings

Grove's OpenAI and Voyage routes both accept `x-api-key` at
`ai-gateway.corp.mongodb.com`. Configure these values in
`self-hosted/mem0/.env`, keeping real credentials out of Git:

```dotenv
# OPENAI_API_KEY contains your Grove key.
OPENAI_BASE_URL=https://ai-gateway.corp.mongodb.com/openai/v1
MEM0_MODEL_API_KEY_HEADER=x-api-key
MEM0_EXTRACTION_MODEL=gpt-4.1-nano

MEM0_EMBEDDING_BASE_URL=https://ai-gateway.corp.mongodb.com/voyage/v1
MEM0_EMBEDDING_MODEL=voyage-4-lite
MEM0_EMBEDDING_API_FORMAT=voyage
MEM0_EMBEDDING_API_KEY_HEADER=x-api-key
MEM0_EMBEDDING_DIMENSIONS=1024
POSTGRES_COLLECTION_NAME=memories_voyage_4_lite_1024

# If OPENAI_API_KEY already contains your Grove key:
MEM0_EMBEDDING_API_KEY=${OPENAI_API_KEY}
# Alternatively set AI_GATEWAY_API_KEY; Compose uses it when
# MEM0_EMBEDDING_API_KEY is unset or empty.
```

Extraction and embedding keys may differ. A running container can retain an older
key than the workspace `.env`; configure each explicitly if needed. Embeddings
use `MEM0_EMBEDDING_API_KEY` when supplied, otherwise the server's
`OPENAI_API_KEY`. A separate embedding URL does not inherit the extraction
gateway's custom header. Set `MEM0_EMBEDDING_API_KEY_HEADER` for that endpoint.

Recreate the API container after changing environment settings:

```sh
self-hosted/mem0/compose.sh up -d --no-deps mem0
bun run src/providers/mem0-local/validate.ts
```

The wrapper explicitly loads the service `.env` regardless of the working
directory. Running Compose from `self-hosted/mem0` without those settings previously
recreated the service with blank gateway headers and default OpenAI embeddings.
The API stayed healthy but ingestion failed. Exported shell variables still
override `.env` values; unset stale overrides before recreating the container.
The older `grove-gateway-prod.azure-api.net` Foundry route uses `api-key` instead.
Keep its header paired with that route if you explicitly choose it.

The `voyage` format sends native Voyage fields: `model`, `input`, `input_type`,
and `output_dimension`. Search calls use `input_type: query`; other embedding
calls use `document`. It omits OpenAI's `encoding_format` field, because the Grove
Voyage endpoint rejects the pinned mem0 client's `encoding_format: float`.
The existing OpenAI client supplies HTTP transport, authentication, and retries.
The embedder's configured provider remains `openai`; the startup module adapts its
request format explicitly.

Voyage documents 1,024 as the default dimension for `voyage-4-lite`, with 256,
512, and 2,048 also supported by the model. Storage/index limits may further
restrict usable sizes. See [Voyage's embedding API](https://docs.voyageai.com/reference/embeddings-api).
This setup uses 1,024 and checks every returned vector before storage or search.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MEM0_EMBEDDING_MODEL` | `text-embedding-3-small` | Model or deployment name |
| `MEM0_EMBEDDING_BASE_URL` | Shared OpenAI endpoint | API prefix, without `/embeddings` |
| `MEM0_EMBEDDING_API_FORMAT` | `openai` | `openai` or native `voyage` request fields |
| `MEM0_EMBEDDING_API_KEY` | `AI_GATEWAY_API_KEY`, then server `OPENAI_API_KEY` | Embedding credential |
| `MEM0_EMBEDDING_API_KEY_HEADER` | Shared custom header only when sharing the endpoint | Optional extra credential header |
| `MEM0_EMBEDDING_DIMENSIONS` | 1536 | Expected vector size and PostgreSQL column size; also requested output size for `voyage` |
| `POSTGRES_COLLECTION_NAME` | `memories` | Separate storage for each embedding configuration |

Overriding the embedding model requires explicit dimensions and a dedicated
collection. For the `openai` format, the dimension setting validates the model's
returned size; it does not send a resizing request. For `voyage`, it also sets
`output_dimension`.

Use a new collection and fresh run IDs when changing models or dimensions. Equal
dimensions do not make different models' vectors interchangeable. Startup rejects
the generic `memories` and `mem0` collection names for custom embeddings; it cannot
detect a different model previously used in an arbitrary named collection.
Existing collections and memories remain intact. If graph mode is enabled, use a
separate graph database for a changed embedding configuration as well.

Live validation on October 8, 2026 passed with the Grove configuration above and
graph extraction disabled. The test verified ingestion, retrieval across two
sessions, a new adapter instance, namespace isolation, and scoped deletion. It
cleaned up the synthetic memories afterward. This verifies the integration; it is
not a LoCoMo accuracy result.

## Connect MemoryBench

```sh
export MEM0_LOCAL_BASE_URL=http://localhost:8888
# Only if the server was started with MEM0_API_KEY:
# export MEM0_LOCAL_API_KEY=<the same server API key>

bun run src/providers/mem0-local/validate.ts
```

The optional server API key travels in `X-API-Key`. It is separate from the
server's model credentials and from MemoryBench's answering/judge credentials.
An unset local API key is supported when server authentication is disabled.
The adapter does not reuse `MEM0_API_KEY`, which may be a cloud credential.

The validation command writes three short synthetic sessions into two random
namespaces. It checks cross-session retrieval, a new adapter instance, namespace
isolation, and scoped deletion. It calls the server's extraction and embedding
models and clears its own namespaces afterward. A healthy `/openapi.json` endpoint
alone does not establish that model authentication or extraction works.

Then start a fresh benchmark run:

```sh
bun run src/index.ts run -p mem0-local -b locomo -l 1 \
  -m gpt-5 -j gpt-5-mini -r mem0-local-locomo-smoke-01

bun run src/index.ts compare -p atlas-agent-engine,mem0,mem0-local \
  -b locomo -s 2 -m gpt-5 -j gpt-5-mini \
  --compare-id locomo-local-cloud-01
```

The compare command creates a shared question selection. These small
samples diagnose integration behavior; broaden conversation coverage before making
provider claims. Restart the MemoryBench UI server to discover the new provider.

## Configuration and comparison policy

The Compose startup defaults graph extraction off, matching the cloud adapter's
`enable_graph: false`. Set `MEM0_GRAPH_ENABLED=true` before recreating the API
container to enable graph extraction. Neo4j data remains intact either way.
The adapter returns vector-memory `results` only. It excludes graph `relations`;
graph-enabled ingestion therefore adds work without feeding those relations to
the answering model. Label that configuration explicitly in comparisons.

Cloud and local extraction share
[extraction-instructions.json](../mem0/extraction-instructions.json).
Local startup appends the `facts` JSON contract required by the pinned OSS library.
This aligns instructions, not the providers' complete extraction implementations.
The standalone request's `prompt` field does not control ordinary fact extraction
in this version. The adapter never calls `/configure` or updates shared settings.

The pinned server defaults to mem0ai 1.0.11, extraction model
`gpt-4.1-nano-2025-04-14`, and embedding model `text-embedding-3-small`.
For Grove/Voyage runs, record `gpt-4.1-nano`, `voyage-4-lite`, native Voyage request
format, 1,024 dimensions, and the dedicated collection, together with the actual
deployed model versions. These settings are part of the measured configuration.
Record the deployed image, model gateway and model mappings, graph mode, instruction
revision, and any server-side overrides with results. Repository defaults do not
prove the configuration of an arbitrary remote endpoint.

The adapter preserves the common source headers, uses `containerTag` as `user_id`
on every operation, and defaults to concurrency two. Search uses the requested
limit, with a default of ten. Answering still uses the common evidence budget and
model policy. See the [comparison guide](../../../docs/benchmarks/README.md).

## Completion and failure behavior

Ingestion waits for the standalone memory operation. Returned IDs acknowledge
memory operations, not cloud jobs. The indexing hook makes no event-status calls,
and readiness records `synchronous-response` with
`extractionCompletionConfirmed: false`. The pinned library can catch extraction
or update errors internally, so an HTTP success or empty result cannot prove
successful extraction. Empty operation arrays produce a warning and remain valid
for sessions without new facts.

Extraction time appears in ingestion duration. Compare ingestion plus indexing
when discussing availability with a cloud provider. Search latency remains a
separate measurement.

Requests have a five-minute timeout and no automatic retries. A timeout or lost
write response can leave remote changes despite a failed local phase. Inspect the
namespace before resuming; the API supplies no idempotency key. Completed sessions
are checkpointed normally, but an uncertain session can be submitted again on
resume. Use fresh run IDs after changing extraction settings or the endpoint.

Malformed JSON, unexpected response shapes, and non-success HTTP statuses fail
explicitly. Error messages omit server bodies because they can contain source
text or credentials. `clear()` deletes only the supplied `user_id`; it never calls
the global reset route.

If the API returns HTTP 500, inspect server logs locally. An upstream HTTP 401 is
a model/gateway credential problem even when the mem0 API itself accepts the
request. Keep secrets and transcript contents out of shared diagnostics.

## Offline checks

```sh
bun test src/providers/mem0-local/provider.test.ts src/providers/mem0/input-parity.test.ts
python3 -B self-hosted/mem0/server_config_test.py
self-hosted/mem0/compose.sh config --quiet
bun x tsc --noEmit
```

The provider tests cover the REST lifecycle, headers, source formatting, namespace
scope, operation parsing, malformed responses, and timeout behavior. The Python
tests verify startup settings without requiring Docker or model credentials.
