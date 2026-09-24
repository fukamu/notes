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

export NOTES_ENVIRONMENT=test
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

go -C backend run ./cmd/notesctl prepare-e2e \
  --environment=test \
  "--allowed-subject=$NOTES_LEGACY_OWNER_SUBJECT"

exec go -C backend run ./cmd/notes
