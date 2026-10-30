#!/usr/bin/env bash
# Starts the local DEV/QA/PROD Postgres servers (docker-compose.dev.yml),
# reseeds each from scripts/seed-local.sql and registers them as D-Pilot
# connections. Safe to re-run: every run resets the data. Needs only Docker
# and Node — psql runs inside the containers.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env && echo "Created .env from .env.example"; }

docker compose -f docker-compose.dev.yml up -d --wait

for env in dev qa prod; do
  echo "Seeding dpilot_$env"
  docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "dpilot-$env-pg" psql -q -U dpilot -d "dpilot_$env" < scripts/seed-local.sql > /dev/null
done

npx tsx scripts/register-local-dbs.ts
