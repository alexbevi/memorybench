#!/bin/sh
# Always use this service's environment file, independent of the caller's cwd.
set -eu
service_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -f "$service_dir/.env" ]; then
  echo "Create $service_dir/.env from grove.env.example and set the gateway key." >&2
  exit 1
fi
exec docker compose --env-file "$service_dir/.env" -f "$service_dir/docker-compose.yml" "$@"
