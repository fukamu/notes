# Notes Go backend

This directory contains the replacement server tracked by parent Issue #409.
The current T03 foundation does not replace production routing or the existing
TypeScript server. It exposes only a fixed local index, process health, closed
readiness, and closed API routes. The PostgreSQL adapter and schema are not yet
connected to an HTTP feature.

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

`/healthz` reports process health. `/readyz` deliberately returns 503 until T04
connects database readiness to the private vertical path. `/api` and `/api/*`
remain closed.

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
