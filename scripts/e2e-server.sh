#!/usr/bin/env bash
set -euo pipefail

e2e_d1_state="$(mktemp -d)"
trap 'rm -rf -- "$e2e_d1_state"' EXIT

if [[ "${FUKAMU_E2E_USE_PREBUILT:-0}" == "1" ]]; then
  if [[ ! -f dist/server/wrangler.json ]]; then
    echo 'Prebuilt E2E requested, but dist/server/wrangler.json is missing.' >&2
    exit 1
  fi
else
  npm run build
fi
npm exec -- wrangler d1 execute DB \
  --local \
  --persist-to "$e2e_d1_state" \
  --config dist/server/wrangler.json \
  --file drizzle/0000_sticky_gamora.sql
npm exec -- wrangler d1 execute DB \
  --local \
  --persist-to "$e2e_d1_state" \
  --config dist/server/wrangler.json \
  --file drizzle/0001_amazing_cannonball.sql
npm exec -- wrangler d1 execute DB \
  --local \
  --persist-to "$e2e_d1_state" \
  --config dist/server/wrangler.json \
  --command 'INSERT INTO sync_state(singleton, next_display_id) VALUES (1, 1)'
npm exec -- wrangler d1 execute DB \
  --local \
  --persist-to "$e2e_d1_state" \
  --config dist/server/wrangler.json \
  --file drizzle/0017_production_launch_gate.sql
npm exec -- wrangler d1 execute DB \
  --local \
  --persist-to "$e2e_d1_state" \
  --config dist/server/wrangler.json \
  --command "INSERT INTO launch_allowed_users(user_id, created_at) VALUES ('fukamu-notes-e2e-user', 1)"
npm start -- --port 3100 --persist-to "$e2e_d1_state"
