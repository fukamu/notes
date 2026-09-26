#!/usr/bin/env bash
set -euo pipefail

repository_root="$(pwd -P)"
static_directory="$repository_root/dist/frontend"
exact_confirmation='delete-live-evidence'

if [[ "${FUKAMU_DELETION_E2E_CONFIRM:-}" != "$exact_confirmation" ]]; then
	echo 'Live deletion E2E requires the exact destructive confirmation.' >&2
	exit 1
fi
: "${FUKAMU_DELETION_E2E_CONTROL:?Deletion E2E control directory is required}"
: "${FUKAMU_DELETION_E2E_TOKEN:?Deletion E2E control token is required}"
control_directory="$FUKAMU_DELETION_E2E_CONTROL"
if [[ "$(dirname -- "$control_directory")" != "${TMPDIR:-/tmp}" ||
	"$(basename -- "$control_directory")" != fukamu-notes-deletion-e2e.* ||
	! -d "$control_directory" || -L "$control_directory" ||
	"$(stat -c '%a' "$control_directory")" != '700' ||
	"$(stat -c '%u' "$control_directory")" != "$(id -u)" ]]; then
	echo 'Deletion E2E control directory is unsafe.' >&2
	exit 1
fi
control_owner="$control_directory/.fukamu-notes-deletion-e2e-owner"
if [[ ! -f "$control_owner" || -L "$control_owner" ||
	"$(stat -c '%a' "$control_owner")" != '600' ||
	"$(stat -c '%u' "$control_owner")" != "$(id -u)" ||
	"$(stat -c '%h' "$control_owner")" != '1' ||
	"$(cat "$control_owner")" != "$FUKAMU_DELETION_E2E_TOKEN" ]]; then
	echo 'Deletion E2E control ownership marker is invalid.' >&2
	exit 1
fi

if [[ "${FUKAMU_E2E_USE_PREBUILT:-0}" == '1' ]]; then
	if [[ ! -f "$static_directory/index.html" ]]; then
		echo 'Prebuilt deletion E2E requested, but dist/frontend/index.html is missing.' >&2
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

# Ignore any raw inherited policy. Only the exact runner-owned confirmation
# above may select this disposable test-only destructive composition.
unset NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/fukamu-notes-deletion-fixture.XXXXXX")"
chmod 700 "$fixture_root"
fixture_record="$control_directory/fixture.path"
printf '%s' "$fixture_root" > "$fixture_record"
chmod 600 "$fixture_record"
server_pid=''
restart_request="$control_directory/restart.request"
restart_completed="$control_directory/restart.completed"
restart_failed="$control_directory/restart.failed"
server_binary="$control_directory/notes-deletion-e2e-server"
cleanup() {
	if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
		kill -TERM "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
	# Keep restart.failed for the browser/launcher to report and remove. The
	# invocation-owned control directory is the bounded diagnostic channel.
	rm -f -- "$restart_request" "$restart_completed" "$server_binary"
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
export NOTES_HTTP_ADDR=127.0.0.1:3101
export NOTES_STATIC_DIR="$static_directory"
export NOTES_PRIVATE_AUTH_MODE=local-signed
export NOTES_PUBLIC_ORIGIN=http://localhost:3101
export NOTES_LOCAL_AUTH_PUBLIC_KEY="$FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY"
export NOTES_DATABASE_MAX_CONNECTIONS=4
export NOTES_BODY_LIMIT_BYTES=4000000
export NOTES_SHUTDOWN_TIMEOUT=10s
export NOTES_LOG_LEVEL=info
export NOTES_LOCAL_FIXTURE_ROOT="$fixture_root"
export NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY="$exact_confirmation"

# This is the only prepare call. Restarts below reuse the same PostgreSQL state
# and guarded filesystem so the browser proves a real mid-saga recovery.
go -C backend run ./cmd/notesctl prepare-e2e \
	--environment=test \
	"--allowed-subject=$NOTES_LEGACY_OWNER_SUBJECT"
go -C backend build -o "$server_binary" ./cmd/notes
rm -f -- "$restart_request" "$restart_completed" "$restart_failed"

start_server() {
	"$server_binary" &
	server_pid="$!"
}

stop_server() {
	local server_status=0
	if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
		kill -TERM "$server_pid" || return 1
		if wait "$server_pid"; then
			server_status=0
		else
			server_status="$?"
		fi
	fi
	server_pid=''
	return "$server_status"
}

start_server
while kill -0 "$server_pid" 2>/dev/null; do
	if [[ -f "$restart_request" && ! -L "$restart_request" ]]; then
		restart_id="$(head -c 128 "$restart_request")"
		rm -f -- "$restart_request"
		if ! stop_server; then
			failed_temporary="$control_directory/restart.failed.$$"
			printf '%s' "$restart_id" > "$failed_temporary"
			chmod 600 "$failed_temporary"
			mv -f -- "$failed_temporary" "$restart_failed"
			exit 1
		fi
		start_server
		completed_temporary="$control_directory/restart.completed.$server_pid"
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
