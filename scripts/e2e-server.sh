#!/usr/bin/env bash
set -euo pipefail

repository_root="$(pwd -P)"
static_directory="$repository_root/dist/frontend"

if [[ "${FUKAMU_E2E_USE_PREBUILT:-0}" == "1" ]]; then
  if [[ ! -f "$static_directory/index.html" ]]; then
    echo 'Prebuilt E2E requested, but dist/frontend/index.html is missing.' >&2
    exit 1
  fi
else
  npm run build
fi

: "${FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY:?E2E public key is required}"
: "${NOTES_LOCAL_AUTH_ISSUER:?E2E issuer is required}"
: "${NOTES_LOCAL_AUTH_AUDIENCE:?E2E audience is required}"
: "${NOTES_LEGACY_OWNER_SUBJECT:?E2E owner subject is required}"
: "${NOTES_LOCAL_FIXTURE_ACCOUNT_ID:?E2E fixture account is required}"
: "${NOTES_LOCAL_FIXTURE_VAULT_ID:?E2E fixture Vault is required}"
: "${NOTES_LOCAL_FIXTURE_SESSION_ID:?E2E fixture session is required}"
: "${NOTES_LOCAL_FIXTURE_SESSION_EPOCH:?E2E fixture session epoch is required}"
: "${NOTES_LOCAL_FIXTURE_SESSION_TOKEN:?E2E fixture session token is required}"
: "${NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY:?E2E fixture cursor key is required}"
: "${NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY:?E2E fixture deletion key is required}"

# This root and every supplied fixture value are disposable test data. The
# profile preflight rejects them outside test/local loopback operation.
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-notes-e2e.XXXXXX")"
chmod 700 "$fixture_root"
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT INT TERM

export NOTES_ENVIRONMENT=test
export NOTES_APPLICATION_PROFILE=local-fixture
export NOTES_DATABASE_URL="${NOTES_TEST_DATABASE_URL:-postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable}"
export NOTES_HTTP_ADDR=127.0.0.1:3100
export NOTES_STATIC_DIR="$static_directory"
export NOTES_PRIVATE_AUTH_MODE=local-signed
export NOTES_PUBLIC_ORIGIN=http://localhost:3100
export NOTES_LOCAL_AUTH_PUBLIC_KEY="$FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY"
export NOTES_DATABASE_MAX_CONNECTIONS=4
export NOTES_BODY_LIMIT_BYTES=4000000
export NOTES_SHUTDOWN_TIMEOUT=2s
export NOTES_LOG_LEVEL=info
export NOTES_LOCAL_FIXTURE_ROOT="$fixture_root"

go -C backend run ./cmd/notesctl prepare-e2e \
  --environment=test \
  "--allowed-subject=$NOTES_LEGACY_OWNER_SUBJECT"

go -C backend run ./cmd/notes &
server_pid="$!"
if wait "$server_pid"; then
  server_status=0
else
  server_status="$?"
fi
server_pid=''
exit "$server_status"
