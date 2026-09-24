#!/usr/bin/env bash
set -euo pipefail

e2e_d1_state="$(mktemp -d)"
e2e_wrangler_logs="$e2e_d1_state/wrangler-logs"

cleanup_e2e_state() {
  local exit_code="$1"
  trap - EXIT

  if [[ "$exit_code" -ne 0 && -d "$e2e_wrangler_logs" ]]; then
    echo 'E2E server exited unexpectedly; Wrangler diagnostics follow.' >&2
    for log_file in "$e2e_wrangler_logs"/*.log; do
      [[ -f "$log_file" ]] || continue
      echo "--- $log_file" >&2
      sed -n '1,240p' "$log_file" >&2
    done
  fi

  rm -rf -- "$e2e_d1_state"
  exit "$exit_code"
}

trap 'cleanup_e2e_state "$?"' EXIT

# Wrangler otherwise shares user-level diagnostics and Miniflare registry state.
# Keep both inside this test run so parallel CI events cannot influence each
# other, and emit bounded diagnostics if the server process exits early.
export WRANGLER_WRITE_LOGS=true
export WRANGLER_LOG_PATH="$e2e_wrangler_logs"
export MINIFLARE_REGISTRY_PATH="$e2e_d1_state/miniflare-registry"

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
