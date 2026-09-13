#!/usr/bin/env bash
set -euo pipefail

e2e_d1_state="$(mktemp -d)"
trap 'rm -rf -- "$e2e_d1_state"' EXIT

npm run build
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
npm start -- --port 3100 --persist-to "$e2e_d1_state"
