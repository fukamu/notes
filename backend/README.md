# Notes Go backend

This directory contains the replacement server tracked by parent Issue #409.
The T05 implementation serves the statically built TypeScript/React frontend,
process health, database readiness, the private launch-status path, and the
v1-compatible sync path from one Go process. It has no request-time Node, Workers,
RSC, or SSR dependency. Disconnected APIs remain closed; non-production
environments keep their legacy 404 fixture contract without connecting
provider operations. The explicit `local-fixture` application profile is a
separate switch for the prepared local runtime foundation. T17 removed the old
TypeScript API/server/database source and D1 toolchain from the repository;
React/browser and build-time TypeScript remain.

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
approved production-key-destruction requirement. T08c initially supplies an
isolated in-memory fake; T13i later adds a local read-only fixture adapter. No
production backup provider, credential, route, scheduler, KMS disable/delete
call, or production recovery claim is configured.

T09a Issue #436 adds the disconnected provider-neutral billing aggregate and
PostgreSQL projection. T09b Issue #438 adds the pure Stripe Checkout/webhook/
reconciliation boundary, exact raw-body HMAC verification, and an official
`stripe-go/v84` v84.4.1 adapter pinned to API `2026-02-25.clover`. The frozen
signed fixture established migration parity and remains Go test evidence, while
local HTTP stubs verify SDK headers, forms, expansions, retrieval fallback, and
provider failures. The Stripe packages are not composed into the server: there
is no route, API key, endpoint secret, provider request, webhook registration,
scheduler, charge, cancellation mutation, entitlement grant, or production
operation.

T13d Issue #478 composes only explicit `notesctl billing reconcile`: it
derives both provider mapping references from an exact Account/Vault-owned
PostgreSQL record, requires the provider response to match both, replays an
exact checkpoint without a provider call, emits bounded redacted
JSON, and requires an invocation-supplied API key. It adds no server route,
scheduler, stored credential, automatic provider request, or fake fallback.
Its verification uses injected fakes, local HTTP stubs, and the disposable
database only.

T13g Issue #486 composes only explicit `notesctl objects orphan-scan`. It
checks exact Account/Vault ownership before inventory, globally protects every
committed, active-intent, and already-queued object key, and enqueues at most an
explicit 1..100 batch in deterministic order. The command is restricted to a
loopback disposable database and an existing private local directory, emits
only redacted counts, and never deletes object bytes. It adds no production
object provider, credential, route, scheduler, deployment, or external
resource operation.

T13h Issue #488 composes only explicit `notesctl objects delete-outbox`. It
checks the exact Account/Vault before selecting or deleting, drains at most an
explicit 1..100 due batch, treats storage `not-found` as an idempotent replay,
reschedules storage failures, and distinguishes applied, replayed, and losing
CAS mutations. Referenced object keys are excluded and remain pending for
investigation. The command accepts only a loopback disposable database and an
existing private local directory and emits redacted counts. It adds no
production object provider, credential, route, scheduler, deployment, or
external resource operation.

T13i Issue #490 composes only explicit `notesctl recovery drill` over two
separate, existing private fixture directories. The read-only backup adapter
loads one strict manifest plus its declared ciphertext files; the fixture-key
adapter binds each local 32-byte DEK to the exact Vault, version, KEK reference,
and wrapped value before the existing recovery core authenticates every object.
The command is local/test-only and emits only versions and counts. It performs
no write, restore, provider request, database operation, backup mutation, or
key retirement/destruction. Local raw fixture keys remain sensitive test data
and are not a production KMS design.

T09c Issue #440 adds the disconnected Go Entitlement core, service, and
PostgreSQL repository. Migration 00008 stores Account/Vault-scoped projections
and Session/SessionEpoch-bound offline leases. Projection CAS and active-lease
revocation are one serializable transaction; lease creation locks and validates
the exact active projection. The explicit product policy caps leases at 24
hours and at the Billing period boundary. Frozen migration fixtures and
disposable-PostgreSQL Go tests cover exclusive expiry, replay, cross-owner
access, old/new paid ordering, issue/lock races, and rollback on revocation failure.
Nothing is composed into an HTTP, notes, quota, or Sync v2 path, and no
production migration or provider operation is performed.

T10a Issue #442 adds the disconnected Go terms-consent core, fail-closed
service, checkout verifier, signup admission adapter, and PostgreSQL immutable
evidence repository. Migration 00009 authorizes insert only for an exact
Personal Vault owner or the exact pre-finalization signup reservation and
blocks updates. A frozen migration fixture fixes canonical JSON bytes and
SHA-256 across `<>&` and U+2028/U+2029 and remains executable Go evidence. Unit and disposable-PostgreSQL tests
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
`/api/launch-status`, the conditionally configured `/api/sync`, and the exact
`local-fixture` routes described below remain closed. Known disconnected routes
return the legacy local/test fixture response only in non-production
environments and a 503 in production; they never execute billing, deletion,
privacy, or terms effects.

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

### Fail-closed local fixture foundation

Issue #509 adds an application profile with exactly two states:
`disabled` (the default when unset) and `local-fixture`. Merely setting fixture
values does not enable it. Production rejects `local-fixture` before reading
its private-directory or secret values. The enabled profile additionally
requires the complete `local-signed` private runtime, an explicit loopback bind
and loopback HTTP origin on the same port, and the exact disposable
`fukamu_notes_go_test` PostgreSQL URL.

The profile is one strictly decoded `LocalFixtureConfig` assembled from the
existing private-runtime database/origin plus these values:

- `NOTES_LOCAL_FIXTURE_ROOT`, an existing absolute, symlink-free, owner-only
  directory separate from the static tree;
- canonical lowercase UUIDv7 account, Vault, and session IDs in
  `NOTES_LOCAL_FIXTURE_ACCOUNT_ID`, `NOTES_LOCAL_FIXTURE_VAULT_ID`, and
  `NOTES_LOCAL_FIXTURE_SESSION_ID`;
- `NOTES_LOCAL_FIXTURE_SESSION_EPOCH` and a canonical 32-byte unpadded
  base64url `NOTES_LOCAL_FIXTURE_SESSION_TOKEN`;
- distinct canonical 32-byte unpadded base64url secrets in
  `NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY` and
  `NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY`.

With this explicit profile, the same `notesctl prepare-e2e` command prepares
only three fixed owner-only child directories (`objects`, `nonces`, `keys`),
creates or reuses one private fixture DEK file, resets only the already
allowlisted disposable schema, migrates it, and transactionally seeds the
launch subject, Account/Vault, hash-only active session, local paid Billing and
Entitlement projections, and wrapped DEK metadata. A retry reuses the exact key
and rows; a mismatched row, key, unexpected root entry, or foreign
Account/Vault scope fails closed. The server opens one PostgreSQL pool, shares
one session resolver, and requires schema, seed, exclusive scope, directory,
and DEK checks to pass before listening and on readiness checks.

Issue #509 established this foundation without mounting a business route.
Issue #510 uses it for local-fixture terms consent, URL-free no-charge checkout
confirmation, and no-effect period-end cancellation. Issue #511 uses the same
pool, scoped hash-only session resolver, and real HTTP clock to mount
`GET /api/session-context` and `POST /api/v2/sync`, closing `/api/sync` in that
profile. PostgreSQL supplies Billing/Entitlement, Sync v2 journal,
encrypted-object metadata, quota, and DEK stores. Guarded fixture directories
supply immutable objects, nonce reservations, and the fixture key; content is
sealed with AES-256-GCM. Entitlement evaluation alone is pinned to the
deterministic fixture timestamp. No external or remote Stripe, KMS, identity,
mail, object, or backup provider is constructed or contacted. See
[`docs/local-commerce-runtime.md`](../docs/local-commerce-runtime.md). This is
local/CI evidence, not production configuration, legal/price approval,
deployment, charging, or cutover approval.

The live notes layout first fetches the strict, private, no-store session
context and constructs the Vault-scoped IndexedDB and Sync v2 runtime only after
authentication. It has no legacy fallback and never returns the bearer token to
browser code. An offline reload therefore remains closed until the session
context can be validated again; already saved local content is opened only
after reconnection. Playwright supplies the deterministic fixture token only as
a host-only `Secure`, `HttpOnly`, `SameSite=Strict` cookie.

No Stripe, GCP KMS, OIDC/mail, remote object, or backup provider is constructed
or contacted. Billing is read only as the seeded local entitlement and commerce
source; checkout never charges and cancellation never contacts a provider. No
login/session issuance, delete wire operation, or legacy-data migration is
enabled. Default and production composition pass none of the local-fixture
Sync v2, session-context, legal, or cancellation runtimes to the HTTP handler,
so those routes stay closed. This is local/CI composition evidence, not
production configuration, deployment, or cutover approval.

The real-PostgreSQL foundation test covers migration, exact closed
`launch_config` (`singleton = 1`, public access disabled, `updated_at = 0`),
seed retry, readiness, session resolution, and key unwrap. The Issue #511
composition test additionally calls `composeRuntime`, sends authenticated HTTP
through the mounted route, verifies filesystem ciphertext contains no
plaintext, reconstructs the process graph, decrypts the persisted card, and
checks direct application deletion replay plus the next Sync v2 tombstone.
The Issue #510 PostgreSQL and whole-process tests exercise terms acceptance,
URL-free checkout, period-end cancellation, cross-owner refusal without writes,
and zero external HTTP(S) requests. Serial Playwright coverage requires real
200 responses from both the commerce and Sync v2 local-fixture routes.
The existing Sync v2 integration suite remains the evidence for
object-before-journal retry, cursor/device/owner isolation, conflicts, quota
admission, dependency failures, and replay. These tests use only the allowlisted
disposable PostgreSQL database and private temporary directories.

Filesystem validation is path-based rather than descriptor-relative. This is
accepted only for an owner-private local/test root on a trusted host; do not
share that root with an untrusted process. Hostile multi-user symlink-swap
hardening remains outside this fixture foundation.

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

`npm run verify:release` builds the production-shaped scratch image, rejects
Node and legacy server artifacts in every runtime layer, verifies the fixed
non-root identity and Git provenance, runs closed-route and graceful-shutdown
smoke checks on a random loopback port, and writes ignored local manifest/SBOM
evidence. See [`docs/go-release-artifact.md`](../docs/go-release-artifact.md).
The command never pushes or deploys the disposable image.

`npm run verify:migration-closure` strictly checks the complete F01-F28 and
V01-V12 evidence inventory and the completed T17 retirement state.
`npm run verify:legacy-retirement` checks all 142 frozen test paths, per-file
digests and dispositions, requires the 127 Go-replaced paths to be absent and
the 11 frontend plus four tooling paths to remain legacy-free, validates
executable replacement evidence plus the ledger's named Go-test anchors, and rejects retired
source/config/script/package reintroduction.
See
[`docs/legacy-typescript-retirement.md`](../docs/legacy-typescript-retirement.md).
F22 has separate Go evidence for ordinary period-end cancellation and the
immediate account-deletion effect. The ordinary handler is connected only to
the no-effect local-fixture provider; Draft PR #404, public/production
activation, and production provider use remain unapproved.

The frozen crypto fixture is decoded by the Go AES-GCM tests; browser wire
fixtures remain TypeScript-only. Focused Go checks are:

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
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run TestScopedDEKReencryptionRunnerPersistsFailureResumeReplayAndOwnerIsolation -count=3
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend test -tags=integration ./tests/integration -run TestScopedOrphanScanRunnerProtectsGlobalInventoryAndResumesBoundedBatches -count=3
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
