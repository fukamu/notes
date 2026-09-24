# Notes Go backend

This directory contains the replacement server tracked by parent Issue #409.
The current T04 foundation does not replace production routing or the existing
TypeScript server. It exposes a fixed local index, process health, database
readiness, and the private launch-status path. Legacy sync and all other API
routes remain closed.

Go 1.27.1 is pinned in `go.mod`, CI, and the container build stage. PostgreSQL
access uses pinned pgx and goose versions; no ORM is used.

## Local start

```bash
NOTES_ENVIRONMENT=local \
NOTES_HTTP_ADDR=127.0.0.1:8080 \
NOTES_STATIC_DIR="$PWD/backend/static" \
go -C backend run ./cmd/notes
```

Required configuration is `NOTES_ENVIRONMENT`, `NOTES_HTTP_ADDR`, and an
absolute `NOTES_STATIC_DIR`. Optional bounded settings are
`NOTES_BODY_LIMIT_BYTES` (default 4,000,000), `NOTES_SHUTDOWN_TIMEOUT` (default
10s), and `NOTES_LOG_LEVEL` (`debug`, `info`, `warn`, or `error`). Invalid or
missing configuration stops the process before it listens.

`/healthz` reports process health. With private mode disabled, `/readyz` and
`/api/launch-status` fail closed. `/api` and API routes other than
`/api/launch-status` remain closed.

## Local signed identity and launch gate

T04 part 1 provides a provider-independent identity verifier and launch-gate
reader. The only concrete identity adapter is `local-signed`, which is for
local and isolated test use. Configuration rejects that mode in `production`.
It is not a selection or simulation of the eventual managed access product.

Enabling the local private runtime requires all of these settings:

- `NOTES_PRIVATE_AUTH_MODE=local-signed`
- `NOTES_DATABASE_URL` and optional `NOTES_DATABASE_MAX_CONNECTIONS` (default
  4, maximum 32)
- `NOTES_PUBLIC_ORIGIN`
- `NOTES_LOCAL_AUTH_ISSUER` and `NOTES_LOCAL_AUTH_AUDIENCE`
- `NOTES_LOCAL_AUTH_PUBLIC_KEY`, a canonical unpadded base64url Ed25519 public
  key
- `NOTES_LEGACY_OWNER_SUBJECT`, a bounded opaque identity

The server receives only the public verification key. Test code owns the
ephemeral private signing key. Assertions have an exact issuer, audience,
subject, issued-at, and expiry contract and a maximum ten-minute lifetime.
Unsigned identity values and the former `Oai-Authenticated-User-Id` header are
not trusted.

With this mode configured, `/readyz` succeeds only when the PostgreSQL schema
is at the embedded migration version and the default-closed launch row exists.
`/api/launch-status` verifies the signed identity before reading the allowlist
and returns a private, non-cacheable response. T04 part 2 will connect the
legacy sync route, enforce the configured single owner and same-origin mutation
checks, and add the browser vertical path. A public launch flag never grants
legacy data access by itself.

## Local PostgreSQL migration

The test fixture is loopback-only, uses a tmpfs instead of a persistent volume,
and is pinned to the PostgreSQL 18.6 multi-architecture image digest.

```bash
docker compose -f deploy/compose.test.yaml up -d postgres
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl migrate --environment=test
```

The command refuses non-loopback hosts, any database name other than
`fukamu_notes_go_test`, production environments, and an environment flag that
does not match `NOTES_ENVIRONMENT`. It does not print connection values.

## Checks

With the Compose database running, run `npm run go:check` from the repository
root. It verifies formatting, vet, unit/process/integration tests, the race
detector, and both commands. The same gate is part of `npm run verify`.
