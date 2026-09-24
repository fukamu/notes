# Go backend migration

This document is the repository-owned status and evidence index for parent
Issue #409. It records implementation state; it is not permission to update
`main`, deploy, create production resources, enable paid/public features, or
delete existing resources.

## Baseline and boundaries

- Audit date: 2026-09-25 JST
- Exact latest `origin/main` and migration research baseline:
  `f423da9932163980485ecc5bc2055b7c8c3b3d8b`
- Integration branch: `integration/409-go-backend-migration`
- Open overlapping work: #403 / Draft PR #404. T09 cancellation and the
  corresponding T12 deletion contract remain dependent on its resolution.
- T01 completed in #410 / PR #411, T02 in #412 / PR #413, T03 in #414 /
  PR #415, T04 part 1 in #416 / PR #417, and T04 part 2 in #418 / PR #419.
  The current integration tip before T05 is
  `0c5469cb920f6581e36978e1350ad22e75586cb2`.
- T05 is Issue #420 on `work/420-static-frontend-go`, branched from that exact
  integration commit. It builds the existing React UI as static assets and
  serves the browser and API from one Go process. It does not select a
  production identity provider or hosting service.
- The source worktree contained untracked `docs/concepts/`; migration work uses
  issue-specific worktrees and does not modify those files.

Production hosting, database provider/region, URL, managed access product,
identity mapping, recurring cost, and shared-service impact are not approved.
Provider-independent Go code, standard PostgreSQL migrations, local fixtures,
and isolated tests may proceed. The current recommended production candidate is
Cloud Run plus same-region Cloud SQL for PostgreSQL and a managed access gate
whose signed identity is verified by Go; this remains a candidate, not a
decision.

## Feature migration matrix

State `A` means connected now, `B` means implemented/tested but disconnected,
and `C` means absent or only a fake/provider gap. A disconnected handler is not
the same contract as its closed route.

| ID  | State | Capability                                  | Go evidence                     | Verification | Status                                       |
| --- | ----- | ------------------------------------------- | ------------------------------- | ------------ | -------------------------------------------- |
| F01 | A     | page delivery / SSR-RSC removal             | T05                             | V01,V10      | implemented on #420; integration pending     |
| F02 | B     | launch gate / private owner                 | T04                             | V02,V03      | signed gate #416; owner/origin enforced #418 |
| F03 | A     | legacy sync                                 | T04                             | V01,V04,V10  | Go/Postgres #418; Go-served UI on #420       |
| F04 | B     | session / CSRF                              | T06                             | V02,V03      | contract captured in #410                    |
| F05 | B     | Google OIDC                                 | T06                             | V03          | pending                                      |
| F06 | B     | email OTP                                   | T06                             | V03          | pending                                      |
| F07 | B     | identity / vault context                    | T06                             | V03,V04      | pending                                      |
| F08 | B     | signup admission                            | T06,T10                         | V03,V07      | pending                                      |
| F09 | B     | vault content                               | T11                             | V04,V05      | pending                                      |
| F10 | B     | sync v2                                     | T11                             | V01,V04,V05  | contract captured in #410                    |
| F11 | B     | envelope encryption                         | T07                             | V06          | format/AAD captured in #410                  |
| F12 | B     | KMS / DEK                                   | T07                             | V06,V09      | pending                                      |
| F13 | B     | key rotation                                | T08                             | V04,V06,V08  | pending                                      |
| F14 | B     | immutable encrypted object                  | T08                             | V04,V06,V08  | pending                                      |
| F15 | B/C   | recovery / reencryption; real backup absent | T08,T13                         | V06,V08      | pending                                      |
| F16 | B     | quota                                       | T11                             | V04,V05      | pending                                      |
| F17 | B     | billing projection                          | T09                             | V04,V07      | blocked on #404 where applicable             |
| F18 | B/C   | Stripe core; production route absent        | T09                             | V07,V09      | pending, remains closed                      |
| F19 | B     | entitlement / offline lease                 | T09                             | V05,V07      | pending                                      |
| F20 | B     | legal checkout evidence                     | T10                             | V01,V07      | contract captured in #410                    |
| F21 | B     | terms consent                               | T10                             | V01,V07      | contract captured in #410                    |
| F22 | B     | normal cancellation                         | T09                             | V07          | blocked on #404                              |
| F23 | B     | account deletion                            | T12                             | V03,V04,V08  | contract captured; #404 overlap pending      |
| F24 | B     | privacy request journal                     | T12                             | V01,V03,V08  | contract captured in #410                    |
| F25 | A/B   | migrations                                  | T03 and feature PRs             | V04,V11      | core #414; legacy singleton seed #418        |
| F26 | B/C   | operations / telemetry; vendor absent       | T13                             | V08,V09      | pending                                      |
| F27 | A/B   | frontend wire contracts                     | T01,T05,T14                     | V01,V10      | static runtime #420; legacy removal T14      |
| F28 | C     | scheduler / realtime services               | none unless separately approved | V08          | intentionally not added                      |

## Verification matrix

| ID  | Required evidence                                       | Current evidence                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------- |
| V01 | shared JSON, strict decoding, black-box HTTP            | same fixture through TS #410 and Go unit/DB/HTTP #418         |
| V02 | signed identity, gate DB, spoof/direct-origin rejection | #416 identity/gate; #418 owner/origin/auth-before-body tests  |
| V03 | session/OIDC/OTP/owner/CSRF failures                    | T01 session/CSRF baseline; full T06 pending                   |
| V04 | empty Postgres, transactions, concurrency, rollback     | #414 empty DB; #418 serial retry/concurrency/rollback/release |
| V05 | sync/quota paging, retry, conflict, limits              | pending T11                                                   |
| V06 | crypto vectors, tamper/AAD/KMS failures                 | T01 format/AAD baseline; full T07+ pending                    |
| V07 | billing/evidence duplicate/order/failure                | T01 browser decoder baseline; T09 pending                     |
| V08 | resumable jobs/deletion fault injection                 | T12/T13 pending                                               |
| V09 | approved isolated provider environment / redacted logs  | external approval pending                                     |
| V10 | browser UI/offline/SW/deep links                        | #420 desktop/mobile: 110 passed, 4 optional feasibility skips |
| V11 | clean build/migrate/image and server-runtime removal    | T14/T17 pending                                               |
| V12 | isolated reference/Go performance comparison            | safe runner in #410; measurements pending                     |

## Intentional security differences

- A client-supplied `oai-authenticated-user-id` will not be trusted by the Go
  origin. A signed, fixed-issuer/audience identity plus an owner decision is
  required before legacy content access.
- The legacy shared table will not become multi-user merely because a public
  flag is enabled.
- Unknown JSON fields, unsafe integers, invalid UTF-8 at the HTTP boundary,
  unpaired escaped UTF-16 surrogates that Go would otherwise replace, forged
  ownership fields, and malformed terminal responses remain rejected.
- Go rejects a resolve mutation for a nonexistent card instead of reproducing
  the D1 path that can create a card from such a mutation. PostgreSQL also
  preserves the stored card timeline invariant when an update timestamp is
  older than that card's creation timestamp.
- The Go mutation route requires the JSON media type and a same-origin header,
  and it completes signed owner authorization before reading the request body.
- These protections are recorded as intentional boundary hardening rather than
  accidental wire compatibility changes.

## T02 runtime foundation

Issue #412 adds the provider-independent Go process without changing current
routing. Go 1.27.1 was rechecked against the official release history on
2026-09-25 and is pinned in `backend/go.mod`, Quality, and the container build
stage. T02 uses the standard library only.

The bootstrap requires an explicit environment, listen address, and absolute
static directory. Invalid configuration exits before listening. It serves a
fixed local index and `/healthz`; `/readyz` returns 503 until T03 supplies
database and migration readiness, and `/api/*` remains closed. Request bodies
are bounded before routing. Logs include method, path, status, and duration but
exclude query strings, headers, bodies, and configuration paths; sensitive
structured attributes are redacted.

`npm run go:check` runs format verification, vet, unit/process smoke tests,
the PostgreSQL integration test, the race detector, and command builds. It is part of the existing read-only
`npm run verify` Quality entry point. The Dockerfile separates the Go build
and static-asset stages and produces a non-root scratch image, but no image is
pushed or deployed by Quality.

## T03 PostgreSQL foundation

Issue #414 adds local, provider-independent PostgreSQL persistence without
selecting or creating a managed database. PostgreSQL 18.6 Alpine is pinned by
multi-architecture image digest for the disposable Compose fixture. The Go
module pins pgx/v5 5.11.0 and goose 3.27.3.

`backend/migrations/00001_core.sql` creates the legacy card/sync tables, the
identity/session/personal-vault control plane, the default-closed launch gate,
and the existing application migration ledger. Goose uses
`notes_goose_versions`; immutable source checksums use
`notes_goose_checksums`; the application-owned `schema_migrations` remains a
separate contract. Checksums are staged before applying SQL so an interrupted
run can resume only with the same migration bytes. Request handlers do not
execute DDL.

The integration test starts from an empty schema and proves repeatable
migration, CHECK/FK/unique and partial-index behavior, rollback when an
expected row is not changed, and checksum-drift rejection. Destructive reset
is refused unless the URL uses loopback and the exact
`fukamu_notes_go_test` database name. `notesctl migrate` additionally requires
the explicit `local` or `test` environment to match `NOTES_ENVIRONMENT` and
never prints the database URL.

```bash
docker compose -f deploy/compose.test.yaml up -d postgres
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl migrate --environment=test
npm run go:test:integration
```

The schema foundation was merged by PR #415. T04 part 1 connects its readiness
and launch-gate reads to HTTP; legacy sync remains disconnected. No production
database, migration, or credential was created.

## T04 part 1: private identity and launch gate

Issue #416 adds the provider-independent identity contract, default-closed
launch decision, PostgreSQL reader, and HTTP composition. It deliberately does
not choose Cloudflare Access or another production provider. The concrete
`local-signed` Ed25519 adapter is available only in local/test environments and
is rejected by production configuration. The server is configured with a
public key only; test code generates the private key.

Signed assertions use exact `alg`, type, issuer, audience, opaque subject,
issued-at, and expiry fields. Canonical base64url, duplicate or unknown JSON
members, trailing content, invalid signatures, future/expired timestamps, and
lifetimes beyond ten minutes are rejected with a fixed error. The former Sites
identity header is rejected rather than treated as authenticated input.

`/api/launch-status` is connected when the private runtime is configured. It
verifies identity before querying the launch configuration and allowlist and
sets `Cache-Control: private, no-store`. Missing identity remains an anonymous
gate check for compatibility; malformed or spoofed identity fails closed with 503. `/readyz` reports ready only when all private dependencies exist, the
embedded Goose version is applied, and the singleton launch row exists.

This first part was a partial vertical slice, not a claim that legacy data
access was live. T04 part 2 added the legacy sync adapter and route,
configured-owner check, same-origin mutation check, and conflict/idempotency
tests; T05 connects the browser path locally. The public launch flag may expose
the shell in the eventual design but must never authorize the shared legacy
collection. Production provider, domain, and recurring-cost choices remain
pending in
[`go-migration-decisions.md`](go-migration-decisions.md).

## T04 part 2: legacy synchronization on PostgreSQL

Issue #418 adds the strict legacy request decoder, serializable PostgreSQL
adapter, exact `POST /api/sync` route, and the second migration that seeds the
legacy display-ID singleton. It preserves sorted mutation application,
idempotent mutation receipts, official display-ID allocation, content-equal
retry behavior, conflict creation, explicit conflict resolution, full-state
response ordering, and the existing fixed Japanese 400/413/500 messages.

The HTTP route is available only when the complete private runtime is
configured. It requires a valid signed subject, a successful launch-gate
decision, exact equality with `NOTES_LEGACY_OWNER_SUBJECT`, the configured
same origin, and `application/json`. Authorization occurs before the bounded
body read. Public launch access alone cannot reach the shared legacy
collection. Responses are private and non-cacheable, and adapter or response
validation failures expose only the fixed error.

Every sync uses one serializable transaction and locks the singleton allocator.
Serialization failures and deadlocks retry at most three total attempts;
cancellation and other database errors stop retrying. Preflight validation
occurs before mutations, all mutation and response validation occurs before
commit, and failed batches roll back. Integration tests cover an empty
database, two-device stale edits, duplicate delivery, concurrent display-ID
allocation, competing conflict resolution, partial-batch rollback, corrupted
stored data, and pool connection return. The shared `legacy-v1.json` fixture is
decoded by the TypeScript contract test and produces the same semantic response
through Go and PostgreSQL.

This completes the server portion of T04. T05 connects the browser portion.
No D1 data was copied, no production database was created, and no production
route was switched.

## T05: static frontend served by Go

Issue #420 replaces the request-time vinext/RSC server with a Vite browser
bundle plus build-time prerendering. The Go process preloads the bounded static
artifact, serves exact public routes and Notes deep links, and returns 404 for
unknown pages and API routes instead of applying an unrestricted SPA fallback.
HTML is `no-store`, content-hashed assets are immutable, and the service worker
and manifest are revalidated. CSP permits only same-origin scripts and does not
use inline-script exceptions.

The existing TypeScript/React UI remains the frontend implementation. Browser
API calls are relative and therefore reach the same Go origin. Public build
configuration has an exact allowlist and is compiled into the artifact; server
environment and secrets are not serialized. `FUKAMU_AUTH_ENTRY_URL` remains
unset until the production identity entry is approved, so the limited-release
screen does not invent or expose an unsupported sign-in URL.

Playwright starts the Go server against a disposable loopback PostgreSQL test
database. It generates a fresh Ed25519 test identity per run, gives the server
only the public key, seeds only the explicit test owner, and sends the signed
assertion from the browser fixture. The test preparation command refuses any
non-loopback or non-test database. Chromium evidence covers the main Notes
flows, deep links, unknown-route denial, offline behavior, conflicts, service
worker behavior, logout purge, public legal pages, and disconnected local
fixtures. The complete desktop and mobile Quality run passed 110 tests; four
existing opt-in feasibility-recording tests remained explicitly skipped in both
projects.

Sync v2, checkout, terms consent, cancellation, privacy requests, and account
deletion remain deliberately disconnected. Protected disconnected routes still
perform signed identity and launch-gate authorization before reading a request
body. Local/test returns the existing fixture-compatible 404; production mode
returns a fixed 503 and performs no business effect. T05 neither publishes nor
starts charging for those capabilities.

## Build, cutover, and rollback status

A local-only Go bootstrap, PostgreSQL schema and legacy sync route, signed test
identity boundary, launch-status route, static frontend artifact, and
reviewable Dockerfile now exist. The old production routing is unchanged. No
managed PostgreSQL instance, pushed image, staging environment, cutover
rehearsal, or production operation exists yet. The eventual release
unit must bind one frontend hash, Go image digest, schema version, public
configuration, secret version references, and identity mapping. Rollback
restores the matching old Sites artifact, configuration, D1, and identity entry
together; it never points the old TypeScript backend at the new PostgreSQL
database or copies writes in both directions. Before integration, T05 rollback
is a normal revert of PR #420; it has no persistent schema or data effect.
