# Notes Go backend

This directory contains the replacement server tracked by parent Issue #409.
The current T02 bootstrap does not replace production routing or the existing
TypeScript server. It exposes only a fixed local index, process health, closed
readiness, and closed API routes.

Go 1.27.1 is pinned in `go.mod`, CI, and the container build stage. The runtime
uses only the standard library at this stage.

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

`/healthz` reports process health. `/readyz` deliberately returns 503 until the
database and migration readiness checks arrive in T03. `/api` and `/api/*`
remain closed in T02.

## Checks

From the repository root, run `npm run go:check`. It verifies formatting, vet,
unit and process smoke tests, the race detector, and both commands. The same
gate is part of `npm run verify`.
