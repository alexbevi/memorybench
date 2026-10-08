#!/bin/sh
# Always use this service's environment file, independent of the caller's cwd.
set -eu
service_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -f "$service_dir/.env" ]; then
  echo "Create $service_dir/.env from grove.env.example and set the gateway key." >&2
  exit 1
fi
# Compose gives shell variables precedence even with --env-file. Treat this
# service's .env as authoritative so stale exports cannot replace its endpoint
# or silently mix credentials, headers, models, and vector collections.
for setting in \
  OPENAI_API_KEY OPENAI_BASE_URL AI_GATEWAY_API_KEY \
  MEM0_MODEL_API_KEY_HEADER MEM0_EXTRACTION_MODEL \
  MEM0_EMBEDDING_MODEL MEM0_EMBEDDING_BASE_URL MEM0_EMBEDDING_DIMENSIONS \
  MEM0_EMBEDDING_API_FORMAT MEM0_EMBEDDING_API_KEY MEM0_EMBEDDING_API_KEY_HEADER \
  MEM0_API_KEY MEM0_GRAPH_ENABLED MEM0_PORT \
  POSTGRES_PASSWORD POSTGRES_COLLECTION_NAME NEO4J_PASSWORD
do
  unset "$setting"
done
exec docker compose --env-file "$service_dir/.env" -f "$service_dir/docker-compose.yml" "$@"
