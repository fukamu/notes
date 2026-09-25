# Notes Go backend

This directory contains the replacement server tracked by parent Issue #409.
The T05 implementation serves the statically built TypeScript/React frontend,
process health, database readiness, the private launch-status path, and the
legacy sync path from one Go process. It has no request-time Node, Workers,
RSC, or SSR dependency. Disconnected APIs remain closed; local/test mode keeps
their explicit 404 fixture contract without connecting provider operations.

Go 1.27.1 is pinned in `go.mod`, CI, and the container build stage. PostgreSQL
access uses pinned pgx and goose versions; no ORM is used.

T06 Issues #422, #424, and #426 also provide disconnected Go session/CSRF,
Google OIDC, Email OTP, verified-email ownership, and signup boundaries. The
session store hashes raw bearer tokens before lookup,
performs rotation and revocation transactionally, and can derive a VaultContext
through an injected resolver. The OIDC core preserves ten-minute single-use
transactions, exact redirect/state/nonce/audience policy, PKCE S256, identity
collision/linking decisions, and same-vault session establishment. Its concrete
provider adapter uses pinned `go-oidc` and `oauth2`; tests exercise discovery,
code exchange, and JWKS signature verification against a local TLS provider.
Email OTP uses an eight-digit/ten-minute single-use core, HMAC-SHA-256 peppered
digests, non-reversible abuse keys, and compare-and-swap storage contracts.
Signup reserves IDs idempotently and atomically creates the account, personal
vault, provider identity, canonical verified-email owner, and hash-only initial
session in PostgreSQL. No auth HTTP route, mail adapter, production challenge
store, rate-limit store, terms adapter, or provider configuration uses these
packages; local signed launch-gate identity and user sessions remain separate
boundaries.

T07 Issue #428 adds a disconnected Go envelope-encryption module. It preserves
the existing AES-256-GCM format and canonical object AAD, keeps DEKs in
zeroizing in-process handles, and obtains key material only through an injected
key-management port. The GCP Cloud KMS REST adapter validates the exact
CryptoKeyVersion, wrapped-key AAD, canonical base64, and CRC32C fields and
fails with fixed errors. Migration 00004 stores wrapped DEK metadata only and
allows one write key per Vault. The production server does not compose these
packages, no persistent nonce adapter is supplied, and no GCP resource,
credential, request, or billing relationship is created.

T08a Issue #430 adds the disconnected immutable encrypted-object repository.
Migration 00005 stores only Vault-scoped metadata, durable write intents, and
delete-outbox state; object bytes remain behind an injected immutable storage
port. Lost-response replay has zero object/crypto calls, upload-plus-DB-failure
reuses and authenticates the same object key, revision updates use CAS, and
active intents are excluded from orphan deletion across all Vaults. The only
storage adapter is an in-memory test/drill fake. No R2 bucket, credential,
provider request, production route, persistent nonce store, or scheduler is
configured.

T08b Issue #432 adds disconnected Go DEK rotation and re-encryption services.
Rotation persists `generating`, `promoting`, and `completed` revisions, destroys
generated raw-key handles on every return path, and changes the PostgreSQL
write-key pointer atomically while retaining old read keys. Re-encryption uses
a durable per-Vault checkpoint, bounded batches, authenticated old ciphertext,
fresh immutable replacement objects, and one transaction for metadata CAS,
old-object outbox enqueue, and checkpoint advance. Old-version intent
reservation and promotion share a Vault advisory lock, so rotation cannot race
a newly reserved old-key write. These services remain uncomposed: no route,
scheduler, real object provider, production KMS request, or key destruction is
enabled.

T08c Issue #434 adds a disconnected fixture-only Vault recovery drill. It
strictly decodes the versioned backup manifest, authenticates every declared
mixed-version object with exact Vault/object/revision AAD, clears recovered
plaintext, and emits only a content-free receipt. The retirement evidence gate
never returns a delete action: even complete evidence stops at a separately
approved production-key-destruction requirement. Its only backup adapter is an
isolated in-memory fake. No production backup provider, credential, route,
scheduler, KMS disable/delete call, or recovery claim is configured.

T09a Issue #436 adds the disconnected provider-neutral billing aggregate and
PostgreSQL projection. T09b Issue #438 adds the pure Stripe Checkout/webhook/
reconciliation boundary, exact raw-body HMAC verification, and an official
`stripe-go/v84` v84.4.1 adapter pinned to API `2026-02-25.clover`. A shared
signed fixture executes through TypeScript and Go, while local HTTP stubs verify
SDK headers, forms, expansions, retrieval fallback, and provider failures. The
Stripe packages are not composed into the server: there is no route, API key,
endpoint secret, provider request, webhook registration, scheduler, charge,
cancellation mutation, entitlement grant, or production operation.

T13d Issue #478 composes only explicit `notesctl billing reconcile`: it
derives both provider mapping references from an exact Account/Vault-owned
PostgreSQL record, requires the provider response to match both, replays an
exact checkpoint without a provider call, emits bounded redacted
JSON, and requires an invocation-supplied API key. It adds no server route,
scheduler, stored credential, automatic provider request, or fake fallback.
Its verification uses injected fakes, local HTTP stubs, and the disposable
database only.

T09c Issue #440 adds the disconnected Go Entitlement core, service, and
PostgreSQL repository. Migration 00008 stores Account/Vault-scoped projections
and Session/SessionEpoch-bound offline leases. Projection CAS and active-lease
revocation are one serializable transaction; lease creation locks and validates
the exact active projection. The explicit product policy caps leases at 24
hours and at the Billing period boundary. Shared TypeScript/Go fixtures and
disposable-PostgreSQL tests cover exclusive expiry, replay, cross-owner access,
old/new paid ordering, issue/lock races, and rollback on revocation failure.
Nothing is composed into an HTTP, notes, quota, or Sync v2 path, and no
production migration or provider operation is performed.

T10a Issue #442 adds the disconnected Go terms-consent core, fail-closed
service, checkout verifier, signup admission adapter, and PostgreSQL immutable
evidence repository. Migration 00009 authorizes insert only for an exact
Personal Vault owner or the exact pre-finalization signup reservation and
blocks updates. A shared TypeScript/Go fixture fixes canonical JSON bytes and
SHA-256 across `<>&` and U+2028/U+2029. Unit and disposable-PostgreSQL tests
cover stale/missing consent, replay, changed-term classification, cross-owner
access, reservation-before-finalization, immutable evidence, and concurrent
duplicate submissions. The package has no HTTP route, configured legal source,
public signup, provider call, production migration, or deployment.

## Local start

```bash
repo_root="$PWD"
npm run build:frontend
NOTES_ENVIRONMENT=local \
NOTES_HTTP_ADDR=127.0.0.1:8080 \
NOTES_STATIC_DIR="$repo_root/dist/frontend" \
go -C backend run ./cmd/notes
```

Required configuration is `NOTES_ENVIRONMENT`, `NOTES_HTTP_ADDR`, and an
absolute `NOTES_STATIC_DIR`. Optional bounded settings are
`NOTES_BODY_LIMIT_BYTES` (default 4,000,000), `NOTES_SHUTDOWN_TIMEOUT` (default
10s), and `NOTES_LOG_LEVEL` (`debug`, `info`, `warn`, or `error`). Invalid or
missing configuration stops the process before it listens.

`/healthz` reports process health. With private mode disabled, `/readyz` and
`/api/launch-status` fail closed. `/api` and API routes other than
`/api/launch-status` and the conditionally configured `/api/sync` remain
closed. Known disconnected routes return the legacy local/test fixture
response only in non-production environments and a 503 in production; they
never execute billing, deletion, privacy, terms, or Sync v2 business effects.

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
not trusted. The frontend sign-in link is omitted unless
`FUKAMU_AUTH_ENTRY_URL` is supplied at build time as a same-origin absolute
path. No production identity entry is selected by T05.

With this mode configured, `/readyz` succeeds only when the PostgreSQL schema
is at the embedded migration version and the default-closed launch row exists.
`/api/launch-status` verifies the signed identity before reading the allowlist
and returns a private, non-cacheable response.

`POST /api/sync` additionally requires the signed subject to equal
`NOTES_LEGACY_OWNER_SUBJECT`, a successful gate decision, the exact
`NOTES_PUBLIC_ORIGIN`, and an `application/json` body. These checks run before
the body is read. The request remains capped at 4,000,000 bytes even if the
general body limit is configured higher. The PostgreSQL adapter applies the
legacy mutations in one serializable transaction with bounded retries for
serialization failures and deadlocks. A public launch flag never grants legacy
data access by itself. T05 Playwright points the browser at this Go route with
an ephemeral private key owned by the test runner. `notesctl prepare-e2e` is
test-only: it requires the `test` environment plus the loopback/exact-database
allowlist, resets only that disposable schema, applies migrations, and inserts
one opaque allowlisted fixture subject.

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
detector, both commands, and Go-served desktop/mobile browser behavior. The
same gate is part of `npm run verify`.

The shared crypto fixture is executed by both TypeScript Web Crypto and Go's
AES-GCM implementation. Focused Go checks are:

```bash
go -C backend test ./internal/cryptocontent/... ./internal/adapters/contentcrypto/... ./internal/adapters/kms/...
go -C backend test ./internal/encryptedobject/... ./internal/adapters/objectstorage/...
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run 'Test(VaultDEKKeyring|EncryptedObject)Postgres'
go -C backend test -race ./internal/cryptocontent/... ./internal/adapters/contentcrypto/... ./internal/adapters/kms/...
go -C backend test -race ./internal/encryptedobject/... ./internal/adapters/objectstorage/...
go -C backend test -race ./internal/billing/...
go -C backend test -race ./internal/stripebilling/... ./internal/adapters/stripe/...
go -C backend test -race ./internal/operations/... ./cmd/notesctl/...
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run TestScopedDEKRotationRunnerPersistsResumeAndOwnerIsolation -count=3
go -C backend test -race ./internal/entitlement/... ./internal/adapters/postgres/...
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run 'TestBilling(ProjectionAtomicityAndReplay|ReconciliationRunnerScopesAndReplaysBeforeProvider)Postgres' -count=3
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run Entitlement -count=1
```

The billing and entitlement checks use only normalized facts, fixtures, and the
loopback disposable database. Migrations 00007 and 00008, their services, and
their PostgreSQL adapters are not composed into an HTTP route and make no
Stripe, cancellation, charge, entitlement-enforcement, or production database
call.
