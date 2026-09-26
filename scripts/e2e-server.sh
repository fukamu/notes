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
restart_request=''
restart_completed=''
server_binary=''
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
	if [[ -n "$restart_request" ]]; then
		rm -f -- "$restart_request" "$restart_completed" "$server_binary"
	fi
  rm -rf -- "$fixture_root"
}
shutdown() {
	exit 0
}
trap cleanup EXIT
trap shutdown INT TERM

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
# The shared browser lane proves durable journal wiring only. Ambient shell
# state must never opt it into destructive account-deletion admission.
export NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY=undecided

go -C backend run ./cmd/notesctl prepare-e2e \
  --environment=test \
  "--allowed-subject=$NOTES_LEGACY_OWNER_SUBJECT"

if [[ -z "${FUKAMU_E2E_RESTART_CONTROL:-}" ]]; then
	go -C backend run ./cmd/notes &
	server_pid="$!"
	if wait "$server_pid"; then
		server_status=0
	else
		server_status="$?"
	fi
	server_pid=''
	exit "$server_status"
fi

restart_control="$FUKAMU_E2E_RESTART_CONTROL"
: "${FUKAMU_E2E_RESTART_TOKEN:?E2E restart-control token is required}"
if [[ ! -d "$restart_control" || -L "$restart_control" ||
	"$(stat -c '%a' "$restart_control")" != '700' ||
	"$(stat -c '%u' "$restart_control")" != "$(id -u)" ]]; then
	echo 'E2E restart control directory must be an owned 0700 directory.' >&2
	exit 1
fi
restart_owner="$restart_control/.fukamu-notes-e2e-owner"
if [[ ! -f "$restart_owner" || -L "$restart_owner" ||
	"$(stat -c '%a' "$restart_owner")" != '600' ||
	"$(stat -c '%u' "$restart_owner")" != "$(id -u)" ||
	"$(stat -c '%h' "$restart_owner")" != '1' ||
	"$(cat "$restart_owner")" != "$FUKAMU_E2E_RESTART_TOKEN" ]]; then
	echo 'E2E restart control ownership marker is invalid.' >&2
	exit 1
fi
restart_request="$restart_control/restart.request"
restart_completed="$restart_control/restart.completed"
rm -f -- "$restart_request" "$restart_completed"
server_binary="$restart_control/notes-e2e-server"
go -C backend build -o "$server_binary" ./cmd/notes

start_server() {
	"$server_binary" &
	server_pid="$!"
}

stop_server() {
	if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
		kill -TERM "$server_pid"
		wait "$server_pid" || true
	fi
	server_pid=''
}

start_server
while kill -0 "$server_pid" 2>/dev/null; do
	if [[ -f "$restart_request" && ! -L "$restart_request" ]]; then
		restart_id="$(head -c 128 "$restart_request")"
		rm -f -- "$restart_request"
		stop_server
		start_server
		completed_temporary="$restart_control/restart.completed.$server_pid"
		printf '%s' "$restart_id" > "$completed_temporary"
		chmod 600 "$completed_temporary"
		mv -f -- "$completed_temporary" "$restart_completed"
	fi
	sleep 0.05
done
if wait "$server_pid"; then
	server_status=0
else
	server_status="$?"
fi
server_pid=''
exit "$server_status"
