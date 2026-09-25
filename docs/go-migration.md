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
  PR #415, T04 part 1 in #416 / PR #417, T04 part 2 in #418 / PR #419, T05
  in #420 / PR #421, and T06 in #422 / PR #423, #424 / PR #425, and #426 /
  PR #427. The integration tip before the current slice is
  `90789d9056fcd77f46ac81d1087f668380d4a65d`.
- T07 envelope encryption, GCP Cloud KMS boundary, and wrapped-DEK keyring were
  integrated by #428 / PR #429. The integration tip before the current slice
  is `6cc1de6e5938f77a5930cd2301ca12399a6c5f0f`.
- T08a immutable object metadata/write intents/delete outbox, T08b durable
  rotation/re-encryption, and T08c recovery/retirement evidence were integrated
  by #430 / PR #431, #432 / PR #433, and #434 / PR #435. T09a Issue #436 starts
  from exact integration tip `dba65ed9e6aa5fedf4456ccb464ec55041468ee9`.
  All encrypted-object paths remain disconnected and do not select or create
  an object/backup resource, expose a content route, run a production job, or
  destroy a key.
- T09a billing aggregate and PostgreSQL projection were integrated by #436 /
  PR #437, and the disconnected Stripe boundary was integrated by #438 / PR
  #439. T09c Entitlement/offline leases were integrated by #440 / PR #441.
  T10a Issue #442 starts from exact integration tip
  `008b3210c863896748c6c09eedf945fdd479659b`. Stripe, Entitlement, and legal
  consent remain disconnected; no credential, provider resource, real request,
  public route, charge, entitlement enforcement, or production data change is
  authorized by these slices.
- T10a terms consent and signup evidence and T10b commercial evidence/checkout
  orchestration were integrated by #442 / PR #443 and #444 / PR #445. T10c
  Issue #446 starts from exact integration tip
  `290fe7686e9751b197ad23cc3334dba72eb38c30`.
- T10c legal HTTP/composition and T09d billing contention hardening were
  integrated by #446 / PR #447 and #448 / PR #449. T11a Issue #450 starts from
  exact integration tip `383587fb7acdcf54026c5cefa40811dd5a2b243f`.
- T11a quota policy/ledger was integrated by #450 / PR #451. T11b Issue #452
  starts from exact integration tip
  `347be2997b38e67502936972f7cb63934efcac43`.
- T11b durable journal was integrated by #452 / PR #453. T11c authenticated
  Sync v2 composition was integrated by #454 / PR #455. T12a Issue #456 starts
  from exact integration tip
  `68e8bc004bde27aed29ad7dd31017baaa9db2592`.
- T12a privacy request journal and closed HTTP were integrated by #456 / PR
  #457. T12b account-deletion saga and closed HTTP were integrated by #458 / PR
  #459. T12c session and Billing effects were integrated by #460 / PR #461.
  T12d Vault live-data purge/write gate was integrated by #462 / PR #463. T12e
  private-object purge was integrated by #464 / PR #465. T12f policy-gated
  account finalization was integrated by #466 / PR #467 without selecting the
  pending production legal-evidence decision. T12g privacy deletion handoff was
  integrated by #468 / PR #469. T13a was integrated by #470 / PR #471 from
  exact integration tip `223b15f1230af906671a088ca3c28b8daae06888` and adds
  only the scoped, read-only quota reconciliation audit runner. T13b Issue #472
  was integrated by PR #473 from exact integration tip
  `3873f0d0ba3f00d22ead784924c9213d29b2a7ea`. T13c Issue #474 starts from exact
  integration tip `9255296776ec269a5c741e17b0e2351b2a561db7`.
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

| ID  | State | Capability                                  | Go evidence                     | Verification    | Status                                                          |
| --- | ----- | ------------------------------------------- | ------------------------------- | --------------- | --------------------------------------------------------------- |
| F01 | A     | page delivery / SSR-RSC removal             | T05                             | V01,V10         | integrated by #420 / PR #421                                    |
| F02 | B     | launch gate / private owner                 | T04                             | V02,V03         | signed gate #416; owner/origin enforced #418                    |
| F03 | A     | legacy sync                                 | T04                             | V01,V04,V10     | Go/Postgres #418; Go-served UI #420                             |
| F04 | B     | session / CSRF                              | T06                             | V02,V03,V04     | Go core/Postgres integrated by #422                             |
| F05 | B     | Google OIDC                                 | T06                             | V03             | Go core/provider adapter #424; disconnected                     |
| F06 | B     | email OTP                                   | T06                             | V03             | Go core/HMAC/CAS #426; disconnected                             |
| F07 | B     | identity / vault context                    | T06                             | V03,V04         | session #422; persistent directories #426                       |
| F08 | B     | signup admission                            | T06,T10                         | V03,V07         | provisioning #426; Go terms adapter #442                        |
| F09 | B     | vault content                               | T11                             | V04,V05         | encrypted hydration composed by #454                            |
| F10 | B     | sync v2                                     | T11                             | V01,V04,V05     | Go application/closed HTTP #454                                 |
| F11 | B     | envelope encryption                         | T07                             | V06             | Go AES-GCM/fixture implemented by #428                          |
| F12 | B     | KMS / DEK                                   | T07                             | V06,V09         | Go local boundary #428; external proof open                     |
| F13 | B     | key rotation                                | T08                             | V04,V06,V08     | Go state machine/Postgres #432; disconnected                    |
| F14 | B     | immutable encrypted object                  | T08                             | V04,V06,V08     | Go core/Postgres #430; disconnected                             |
| F15 | B/C   | recovery / reencryption; real backup absent | T08,T13                         | V06,V08         | reencryption #432; fixture recovery #434                        |
| F16 | B     | quota                                       | T11                             | V04,V05         | Go ledger #450; sync composition #454                           |
| F17 | B     | billing projection                          | T09                             | V04,V07         | Go core/Postgres #436; deletion cancellation effect #460        |
| F18 | B/C   | Stripe core; production route absent        | T09                             | V07,V09         | Go core/SDK adapter #438; remains closed                        |
| F19 | B     | entitlement / offline lease                 | T09                             | V05,V07         | Go core/Postgres #440; disconnected                             |
| F20 | B     | legal checkout evidence                     | T10                             | V01,V07         | core/store #444; closed Go HTTP #446                            |
| F21 | B     | terms consent                               | T10                             | V01,V07         | core/store #442; closed Go HTTP #446                            |
| F22 | B     | normal cancellation                         | T09                             | V07             | blocked on #404                                                 |
| F23 | B     | account deletion                            | T12                             | V03,V04,V07,V08 | saga #458; effects #460/#462/#464; finalizer #466; handoff #468 |
| F24 | B     | privacy request journal                     | T12                             | V01,V03,V08     | Go journal/closed HTTP #456; deletion handoff #468              |
| F25 | A/B   | migrations                                  | T03 and feature PRs             | V04,V11         | core #414; legacy singleton seed #418                           |
| F26 | B/C   | operations / telemetry; vendor absent       | T13                             | V08,V09         | quota #470/#472; deletion audit #474; others pending            |
| F27 | A/B   | frontend wire contracts                     | T01,T05,T14                     | V01,V10         | static runtime #420; legacy removal T14                         |
| F28 | C     | scheduler / realtime services               | none unless separately approved | V08             | intentionally not added                                         |

## Verification matrix

| ID  | Required evidence                                       | Current evidence                                                                                                                                                     |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | shared JSON, strict decoding, black-box HTTP            | sync #410/#418/#454; legal #442/#444/#446; privacy #456                                                                                                              |
| V02 | signed identity, gate DB, spoof/direct-origin rejection | #416 identity/gate; #418 owner/origin/auth-before-body tests                                                                                                         |
| V03 | session/OIDC/OTP/owner/CSRF failures                    | session/CSRF #422; OIDC #424; OTP/owner #426; legal #446; privacy #456; deletion #458; privacy/deletion owner binding #468                                           |
| V04 | empty Postgres, transactions, concurrency, rollback     | #414/#418; signup #426; object #430; billing/lease #436/#440; legal #442/#444; quota #450/#472; sync #452/#454; privacy #456; deletion #458/#460/#462/#464/#466/#468 |
| V05 | sync/quota paging, retry, conflict, limits              | quota #450/#472; journal #452; authenticated encrypted composition #454                                                                                              |
| V06 | crypto vectors, tamper/AAD/KMS failures                 | envelope/KMS #428; rotation #432; recovery/AAD #434                                                                                                                  |
| V07 | billing/evidence duplicate/order/failure                | projection #436; Stripe #438; lease #440; legal #442/#444/#446                                                                                                       |
| V08 | resumable jobs/deletion fault injection                 | object #430; durable re-encryption #432; recovery #434; privacy #456; deletion saga/effects/handoff #458/#460/#462/#464/#466/#468                                    |
| V09 | approved isolated provider environment / redacted logs  | external approval pending                                                                                                                                            |
| V10 | browser UI/offline/SW/deep links                        | #420 desktop/mobile: 110 passed, 4 optional feasibility skips                                                                                                        |
| V11 | clean build/migrate/image and server-runtime removal    | T14/T17 pending                                                                                                                                                      |
| V12 | isolated reference/Go performance comparison            | safe runner in #410; measurements pending                                                                                                                            |

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
- Verified-email collision keys now preserve the local part and lowercase the
  domain for both OIDC and Email OTP. The TypeScript OIDC path did not apply
  that domain normalization, which could split one verified address by domain
  case.
- Signup finalization stores only a session-token hash. The TypeScript
  provisioning seam exposed a session ID without a usable bearer token; Go
  creates the token at the trusted boundary and returns the plaintext only in
  the successful in-process receipt. An idempotent retry rotates that hash and
  returns a fresh usable token rather than pretending plaintext can be
  recovered from storage.
- Immutable object keys are globally unique in PostgreSQL and every orphan or
  delete-outbox read excludes keys protected by any Vault. The TypeScript D1
  indexes scoped key uniqueness to one Vault; retaining that shape with one
  shared object namespace could let a colliding key be collected by another
  Vault. Go therefore fails closed across the whole object namespace.
- Billing reconciliation no longer drops a different provider snapshot merely
  because it has the same millisecond `observedAt` as the prior snapshot.
  Exact snapshot IDs remain durably deduplicated, older observations remain
  stale, and same-time delinquency still dominates paid evidence. The
  TypeScript oracle carries the same regression fix.
- The pinned Stripe Clover Invoice shape no longer contains the legacy `paid`
  boolean. TypeScript and Go derive paid state from the validated `paid` status
  instead of rejecting current provider payloads or trusting a contradictory
  duplicate boolean. The shared signed fixture omits that removed field.
- PostgreSQL terms evidence may be inserted either for an exact existing
  Account/Vault owner or for the exact pre-finalization signup reservation.
  The TypeScript D1 table's immediate Vault foreign key cannot represent its
  documented reserve-then-consent-then-finalize order. A trigger preserves
  owner enforcement without weakening signup ordering; evidence deletion is
  left to the explicit T12 account-deletion workflow rather than an implicit
  cascade.
- Terms acceptance and commercial checkout keep independent submission IDs.
  The TypeScript verifier incorrectly used the commercial idempotency key to
  find a separate terms record even though the two UI boundaries generate
  independent IDs. Go verifies the latest owner-scoped evidence against the
  authoritative current terms, honors an explicitly reviewed notice-only
  classification, and still rejects missing or reconsent-required evidence
  before recording commercial evidence or calling a provider.
- Go Sync v2 rejects duplicate JSON members, invalid UTF-8, unpaired escaped
  surrogates, unknown fields, non-integral numbers, and unsafe integers before
  they reach the application. Its HMAC cursor parser authenticates the opaque
  bytes before decoding exact Vault/device/window claims. Unknown future
  Entitlement denial values fail closed as `503`; only the enumerated billing
  and subscription lock reasons map to `402`.
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

PR #421 merged this slice into the migration integration branch at
`62da18763c92fc339aebc33cd61612bfb7ac883e`. Its post-merge verification passed
the complete repository gate. `main` and production remained unchanged.

## T06 session and CSRF slice

Issue #422 ports the provider-neutral session lifecycle before OIDC or OTP is
connected. `backend/internal/identity` now owns UUIDv7 identity values,
bounded epochs and timestamps, fixed-shape 256-bit session tokens, pure
create/authorize/rotate/revoke decisions, VaultContext checks, strict host
cookie serialization/parsing, and the exact same-origin CSRF decision. Clock,
session IDs, and token entropy remain injected values. Cross-site requests and
ambiguous cookies are rejected before a resolver lookup.

The PostgreSQL session adapter hashes a presented token with SHA-256 and stores
or queries only the canonical unpadded base64url digest. Creation is constrained
to an existing account/vault owner. Rotation revokes the exact predecessor and
inserts its successor in one serializable transaction; a stale token, changed
epoch, duplicate ID/hash, zero-row update, or losing concurrent rotation rolls
back. Single-session revocation distinguishes an applied write from an already
identical revoked record. Account-wide revocation verifies the owner and rolls
back if any active session cannot be covered by the supplied revocation time.

The shared T01 session/CSRF fixture is decoded by both TypeScript and Go tests.
Go unit and disposable-PostgreSQL integration tests cover expiry, scope denial,
cookie ambiguity, CSRF-before-lookup, raw-token non-persistence, duplicate
constraints, rotation rollback, idempotent revoke, concurrent one-winner
rotation, and all-or-nothing account revocation.

This is an implemented but disconnected capability. No sign-in, callback,
OTP, signup, logout, or session-management HTTP route is enabled. Provider
selection, external resources, production data, deployment, and `main` remain
outside this Issue. OIDC and OTP/signup are later T06 slices; the whole-flow
race between account deletion and session issuance remains T12.

## T06 Google OIDC slice

Issue #424 ports the disconnected TypeScript OIDC values, transaction and
callback policies, claim validation, identity-resolution rules, signup seam,
and session-establishment decision into `backend/internal/identity`. State and
nonce are independent canonical 256-bit base64url values, the PKCE verifier is
retained only in the server-side ten-minute transaction, and only an S256
challenge enters the authorization request. Callback state is consumed before
provider denial, exchange, or any later validation so every result is
single-use. External failures collapse to the same public authentication error.

The concrete adapter pins `github.com/coreos/go-oidc/v3/oidc` and
`golang.org/x/oauth2`. It requires exact discovery issuer and authorization
endpoint agreement, sends the stored verifier and redirect URI during code
exchange, and verifies the ID-token signature, JWKS origin, issuer, audience,
and expiry before the application boundary rechecks the exact issuer allowlist,
`azp`, issued-at skew, nonce, subject, and verified email. Tests use only an
ephemeral local TLS provider and local JWKS; they make no Google request and
create no provider resource.

The current schema review found no persisted verified-email attribute in
`identities`; the TypeScript `findAccountIdByVerifiedEmail` port likewise has
only a fake implementation. The Go boundary therefore keeps issuer/subject and
verified-email lookup behind a typed fail-closed directory port. It does not
infer email from subject or add an unsafe partial PostgreSQL lookup. The T06
OTP/signup control-plane slice must add the verified-email persistence model,
uniqueness/race tests, signup finalization, and a real transaction-store choice
before auth publication.

This capability remains disconnected. There is no sign-in/link/callback route,
client or secret configuration, callback-browser binding, production pending
transaction store, or external call in the running server. Because Strict
session cookies are not sent on the cross-site Google callback, the missing
short-lived browser binding remains a publication blocker; the session cookie
policy is not weakened to compensate. `main`, deployment, production data, and
external resources remain unchanged.

## T06 Email OTP and signup control-plane slice

Issue #426 ports the Email OTP state machine, abuse-policy decisions, identity
resolution, and provider-neutral signup admission. The pure core fixes an
eight-digit code, ten-minute lifetime, 60-second resend interval, five failed
attempts, three total sends, and one-hour 5/30/5 address/network/account
windows. Pending records are versioned; compare-and-swap makes correct-code
completion single-use under concurrency. Start and resend are
enumeration-resistant, completion exposes one generic failure, and a delivery
failure invalidates the challenge.

Concrete cryptographic adapters use unbiased operating-system entropy, UUIDv7
challenge and control-plane IDs, 256-bit salts/tokens, framed HMAC-SHA-256 with
a server-held pepper for OTP digests, constant-time comparison, and separate
HMAC namespaces for address, trusted-network, and account rate keys. The only
challenge store, rate-limit store, and delivery adapter in this slice are
race-safe in-memory test doubles. No code, raw address-derived abuse key, or
raw session token is persisted or logged.

Migration 00003 adds a provider-neutral one-owner-per-canonical-email table and
idempotent signup reservations. The PostgreSQL finalizer creates the account,
personal vault, provider identity, verified-email owner, and initial session in
one serializable transaction. It accepts only a session-token hash, checks all
rows before replay, and rotates the replayed session hash while retaining the
same reserved identifiers. Constraint collisions and partial writes roll back.
OIDC and OTP both recheck that an admission receipt belongs to the exact
verified identity and terms submission they supplied.

The shared Email OTP fixture is decoded and executed by TypeScript and Go.
Unit, race, and disposable-PostgreSQL tests cover normalization, expiry,
five-failure lock, resend invariants, delivery failure, rate limits, replay,
sixteen-way completion races, cross-provider email ownership, malformed rows,
idempotent provisioning, raw-token non-persistence, conflict rollback, and
connection return.

This is still a disconnected capability. There is no auth HTTP/UI route,
persistent production challenge or rate-limit backend, mail adapter, OTP
pepper configuration, OIDC transaction store, callback-browser binding, or
T10 production terms adapter. Those are publication blockers; the running Go
server continues to keep the routes closed.

## T07 envelope encryption, KMS, and keyring slice

Issue #428 ports the existing `fukamu-envelope-aes-256-gcm/v1` contract to Go.
The pure model validates Vault/object/revision/version binding and serializes
the same canonical JSON AAD tuple as TypeScript. The effect adapters use a
32-byte DEK, 96-bit nonce, and 128-bit AES-GCM tag. Reads authenticate Vault,
object kind and ID, object revision, crypto format, and DEK version; relabeling
or ciphertext modification fails closed. Encryption requires an injected
nonce reservation and retries collisions at most four times. Only test fakes
implement that reservation in T07; a production nonce store is deferred until
an encrypted write route is separately approved.

The GCP Cloud KMS adapter creates DEKs locally, sends only the DEK and
Vault/version/KEK-bound AAD to the exact configured CryptoKeyVersion, and
stores only returned ciphertext metadata. Encrypt and decrypt requests include
CRC32C. Responses must confirm input checksums and return matching output
checksums; malformed base64/JSON, a different key, provider error, quota error,
timeout, or cancellation returns one fixed error without plaintext fallback.
Key buffers use copied, zeroizing handles and render as redacted values. The
adapter does not log provider bodies, access tokens, wrapped values, or raw key
material.

Migration 00004 adds PostgreSQL `vault_dek_versions` with a Vault/version
primary key, Vault foreign key, exact metadata bounds, and a partial unique
index that permits only one write key per Vault. It contains no raw-key,
plaintext, title, or body column. The Go store rejects malformed rows and
builds a keyring only when exactly one stored version is the write version.
Deletion follows the existing personal-Vault foreign key, but T07 does not run
deletion or add the T08 rotation/recovery workflow.

The shared fixture contains a deterministic key, nonce, plaintext, canonical
AAD, and ciphertext. TypeScript Web Crypto and Go independently seal to the
same bytes and open them. Go unit/race tests also cover tamper, object/revision
swap, cross-Vault access, unknown versions, nonce collision, KMS transport and
checksum failures, timeout, redaction, and destroyed key handles. Disposable
PostgreSQL tests cover Vault isolation, mixed-version reads, the single-write
constraint, foreign-key rejection, cascade behavior, and the exact metadata
columns.

No real Cloud KMS request is part of these checks. A future production choice
would add provider charges, IAM, credentials/workload identity, region and
protection-level decisions, monitoring, and a retained-key recovery policy;
none is approved by #428. Local rollback removes the disconnected composition
and recreates only the disposable test schema. If migration 00004 is ever
approved for a persistent environment, rollback must be a reviewed forward
migration: retain ciphertext and every referenced readable KEK version, stop
new encrypted writes first, and never drop metadata or destroy provider keys
as part of a code rollback.

## T08a immutable encrypted object slice

Issue #430 ports immutable encrypted-object metadata and its DB/object
non-atomicity controls. The pure Go model preserves write-ID replay, initial
and next-revision rules, timeline checks, pending-intent matching, ciphertext
format/version/size checks, grace-period orphan selection, and deterministic
delete retry. The application service reserves an opaque object key before
encryption, uses put-if-absent, and commits metadata with revision CAS. A
successful replay returns before key generation, encryption, KMS/nonce, or
object-storage access.

If object upload succeeds but the metadata call fails or its response is lost,
the durable intent keeps the same object key. A restart reads that immutable
object, validates its envelope, decrypts it with the exact Vault/object/revision
AAD, compares the plaintext, and then retries only the metadata commit. It
never generates a replacement nonce or DEK for that stored object. A CAS loser
is placed on the delete outbox; object deletion is asynchronous and retries
without treating not-found as failure.

Migration 00005 stores metadata, write intents, and delete-outbox state only.
It has no plaintext, ciphertext, title, body, or provider credential column.
Committed and pending object keys are globally protected, while every content
lookup and write ID remains Vault-scoped. Orphan collection lists all protected
keys and the PostgreSQL adapter rechecks both committed metadata and active
intents before exposing a ready deletion; a key already queued for deletion
cannot be reserved by a new intent. Tests prove crash/restart resume,
lost-response call counts, cross-Vault denial, ciphertext-swap rejection,
active-intent protection, size ceilings, and retry timing.

The only object-storage implementation in this slice is a copy-on-read/write
in-memory fake for isolated tests and drills. A cryptographic opaque-key
generator exists but is not composed into the running server. There is no R2
adapter, bucket, credential, network call, persistent nonce store, production
route, or scheduled collector. T08b added DEK rotation/reencryption checkpoints,
and T08c #434 adds fixture recovery verification. Selecting a real storage
provider remains an approval item with cost, retention, region, IAM, and
shared-service impact.

Rollback before any persistent apply removes this disconnected code and
recreates only the disposable test schema. After a separately approved
persistent apply, rollback must stop new encrypted writes, retain migration
00005 rows and every referenced immutable object, and use a reviewed forward
migration. It must not drop intents/outbox state, delete objects, or destroy
keys as part of a code rollback.

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
database or copies writes in both directions. T05 rollback now requires
reverting the PR #421 merge as a reviewed integration change; it has no
persistent schema or data effect. T06 #422 reuses the T03 session schema and is
still disconnected, so its rollback removes Go code without migrating or
deleting stored data. T06 #424 adds no schema or provider resource; rollback
removes the disconnected Go OIDC core/adapter and its pinned dependencies. T06
#426 adds migration 00003 only to disposable local/test PostgreSQL. Before any
approved production apply, rollback is a reviewed code revert plus recreation
of that disposable schema. After a future production apply, rollback must first
disable new signup, retain verified-email ownership and terms evidence, and use
a separately reviewed forward migration; it must not drop 00003 or expose the
old TypeScript signup path against partially provisioned Go state.
T07 #428 similarly applies migration 00004 only to disposable local/test
PostgreSQL and makes no provider call. A future persistent apply must preserve
wrapped metadata and referenced KEK versions across rollback; key disable or
destruction is a separate, explicitly approved recovery/retirement operation.
T08a #430 applies migration 00005 only to the same disposable database and uses
only in-memory object storage. A future rollback must preserve object metadata,
pending intents, outbox entries, and immutable objects until the T08 recovery
procedure proves their disposition.

## T08b DEK rotation and durable re-encryption slice

Issue #432 ports the existing rotation state machine and re-encryption batch to
Go. Rotation is owner-scoped and revision-CAS guarded through `generating`,
`promoting`, and `completed`. The KMS call occurs only after `generating` is
durable. Its raw key handle is destroyed even when returned metadata is
rejected. Promotion inserts or verifies the exact wrapped target metadata,
changes the sole PostgreSQL write-key flag, and completes the operation in one
transaction. Old wrapped versions remain readable; no retirement or provider
delete is performed.

Migration 00006 adds rotation operations and per-Vault re-encryption jobs. The
TypeScript oracle accepted a caller-held checkpoint; the migration plan
requires restart safety, so the Go repository makes target version, ordered
cursor, state, and CAS revision durable. Each successful candidate transaction
changes only physical encrypted-object metadata, enqueues the old immutable
key, and advances that checkpoint atomically. A lost response resumes after
the committed candidate. A metadata or checkpoint CAS loss commits neither DB
change; its uploaded replacement is an orphan handled by the existing grace
period collector.

The batch authenticates the recorded Vault/object/revision AAD before creating
fresh ciphertext with the promoted write version. It rejects newer-version
inventory, resets a cursor when older rows appear behind it, and waits for
old-version intents. Intent reservation now requires the current stored write
version. It and key promotion take the same Vault-scoped transaction advisory
lock, preventing an old-version intent from being newly committed after
promotion. Completed jobs return without object, key-generation, encryption,
or KMS work.

Unit, race, and disposable-PostgreSQL tests cover concurrent start with one
winner, KMS/storage/authentication failure, generated-key zeroization,
cross-owner isolation, response loss after both rotation and re-encryption DB
commits, process-style service reconstruction from the durable cursor,
pending writes, scan reset, and mixed-version reads. The only object adapter is
the isolated in-memory fake. There is no public route, scheduler, real R2
adapter, production KMS call, staging resource, key retirement, or recovery
claim in T08b; T08c owns the fixture recovery drill and retirement gate.

Before any approved persistent apply, rollback is a reviewed code revert and
disposable-schema recreation. After a persistent apply, stop rotation and
re-encryption workers but retain migration 00006, all old/new wrapped metadata,
job checkpoints, object metadata, and outbox rows. Resume from the recorded
revision after restoring the matching artifact. Never reset the cursor, drop
these tables, delete old objects, or disable/destroy a KEK/DEK merely to roll
back application code.

## T08c recovery drill and retirement evidence gate

Issue #434 ports the versioned recovery manifest, drill decisions, application
service, and key-retirement evidence gate to Go. A shared fixture passes through
both the TypeScript and Go strict decoders. The Go decoder rejects unknown
fields, foreign scope, inconsistent rotation/keyring/checkpoint state,
duplicate object identities or keys, unavailable DEK versions, and retention
beyond 30 days before object access.

The drill reads only through a provider-neutral backup port. For every declared
mixed-version object it checks stored byte count and envelope/DEK version, then
authenticates the exact Vault/object/revision AAD. Recovered plaintext is
cleared immediately. The only output evidence contains opaque scope, operation,
and backup identifiers, timestamps, version numbers, and counts; it contains no
plaintext, ciphertext, object key, wrapped DEK, or raw key. Missing objects,
malformed/swapped/tampered ciphertext, wrong keys, provider failure, expired
retention, and incomplete re-encryption return explicit blocked results and no
receipt.

The retirement gate requires a completed exact-scope rotation, complete active
and backup inventories, no old object or pending old write, confirmed source-key
backup expiry/deletion, and a matching recovery receipt that covers source and
target versions. Even when every condition holds, the terminal result is only
`explicit-production-key-destruction-approval-required`. No disable, delete, or
destroy port exists behind the gate. The only backup adapter is an isolated
copying in-memory fixture; there is no provider, credential, route, scheduler,
production operation, or recovery claim.

Rollback removes the disconnected codec, service, and fake only. It preserves
rotation and re-encryption state, all old/new wrapped metadata, immutable
objects, backups, and evidence. A real provider choice, production recovery
drill, backup deletion, or key disable/destruction requires a separate reviewed
operation naming the exact resource, approval, retention window, audit record,
and recovery path. T13 will compose an explicit local operations command around
this application boundary without turning readiness into automatic deletion.

## T09a billing aggregate and PostgreSQL projection slice

Issue #436 ports the provider-neutral billing aggregate and application
service to Go. Checkout starts with no entitlement evidence. Only verified
provider facts or a reconciliation snapshot can establish trial, paid,
delinquent, scheduled-cancellation, or terminal-cancellation state. Provider,
customer, subscription, owner, and subscription-ID mappings fail closed. A
payment-method update never clears delinquency, and same-time delinquency wins
over paid evidence regardless of delivery order.

Migration 00007 adds one Account/Vault-scoped subscription aggregate, checkout
intents, provider-event receipts, and reconciliation checkpoints. A
serializable transaction locks the aggregate, inserts the unique receipt or
checkpoint, and advances the version-CAS projection together. Lost responses
replay as duplicates without advancing state. Concurrent different events from
one expected version produce one applied result and one CAS conflict; reuse of
an event or snapshot ID for a different subscription is rejected. The schema
stores historical `last_delinquency_at` separately from the current lifecycle
shape so a terminal transition does not erase ordering evidence.

The shared `billing/projection.json` fixture runs through both the TypeScript
and Go cores. Unit and disposable-PostgreSQL tests cover owner rejection,
mapping mismatch, duplicate/lost-response replay, same-second event ordering,
same-millisecond distinct snapshots, cross-subscription ID collision, and
concurrent CAS. This slice has no Stripe SDK or HTTP transport, signature
verification, provider call, public route, charge, cancellation request,
entitlement grant, offline lease, deployment, or production schema apply.
T09b owns the disconnected Stripe adapter and T09c owns Entitlement. Normal
cancellation remains dependent on #403 / Draft PR #404 and is not inferred
from this projection work.

Before any approved persistent apply, rollback is a reviewed code revert plus
disposable-schema recreation. After a persistent apply, stop billing ingestion
while preserving migration 00007, every event receipt/checkpoint, provider
mapping, version, and historical timestamp. Resume only with the matching
artifact and schema. Never drop billing evidence, synthesize entitlement,
cancel a provider subscription, or replay a provider event as part of code
rollback.

## T09b Stripe core and official SDK adapter slice

Issue #438 ports the pinned Stripe Checkout, webhook, and reconciliation
boundary to Go. The pure core validates test/live mode, API version, return
URLs, contract evidence and metadata, provider identifiers, timestamps,
subscription/customer mapping, trial duration, invoice periods, cancellation
facts, and provider snapshots before calling the T09a Billing service. Checkout
uses the same intent ID for the Stripe idempotency key, so a lost response can
be retried without creating a second logical checkout.

The HMAC verifier authenticates the exact raw request bytes with a bounded
header/body and five-minute recency window. Supported events map to typed facts
or a retrieve-and-reconcile plan; unsupported events are ignored without a
Billing write. Billing's durable receipts, checkpoints, ordering, and CAS from
#436 remain the only authority for duplicate or reordered delivery.

The official `stripe-go/v84` v84.4.1 adapter pins
`2026-02-25.clover`, emits the required Checkout fields, validates provider
metadata and hosted redirect, and retrieves expanded Subscription state. The
shared signed fixture executes through the existing TypeScript boundary and
the Go boundary; HTTP-stub tests exercise exact headers/forms, expanded and
unexpanded PaymentIntent paths, and provider errors without external calls.

The slice deliberately has no server composition, public route, credential,
Stripe object, webhook registration, scheduler, real charge, cancellation
request, entitlement grant, production data change, or deployment. Rollback is
a code revert of the disconnected packages and SDK dependency; it must not
delete Billing evidence or Stripe resources. A future approved connection must
first test the pinned endpoint version and provider object/expansion shapes in
an isolated Stripe test environment, document redacted telemetry and replay,
and preserve the closed route as the recovery path. Normal cancellation still
depends on #403 / Draft PR #404.

## T09c Entitlement and offline-lease slice

Issue #440 ports the provider-neutral Entitlement core and application service
to Go. Billing remains the sole source of subscription facts; Entitlement turns
validated facts into Account/Vault-scoped trial, paid, or locked projections.
Notes read/write/sync fail closed when ownership, Billing, projection, or
storage is unavailable. Billing recovery, cancellation, account deletion, and
support remain reachable only after ownership succeeds. An old paid fact never
overwrites a newer delinquency state, while a strictly newer verified paid
period can restore content access.

Migration 00008 adds `entitlement_projections` and
`entitlement_offline_leases`. Projection version-CAS and active-lease
revocation share one serializable transaction. Lease creation locks the exact
projection and checks its version, Billing source, owner, active state, and
period boundary before insert. A concurrent lock therefore either prevents a
lease or atomically records its revocation; a failed revocation rolls back the
projection update. PostgreSQL foreign keys additionally ensure that a
projection references an existing Billing subscription, while the adapter
verifies that the subscription owner exactly matches the projection owner.

The product policy is passed explicitly and caps a lease at 24 hours or the
trial/paid-period end, whichever comes first. Leases bind Account, Vault,
Session, and SessionEpoch, authorize only offline notes read/write, and expire
at the exact `expiresAt` boundary. The shared `billing/entitlement.json`
fixture executes through both TypeScript and Go. Unit and
disposable-PostgreSQL tests cover owner and session isolation, exclusive
expiry, policy/period capping, replay and identifier conflict, missing or
malformed data, CAS retry, old/new paid ordering, payment-failure revocation,
lock/issue races, and rollback on injected revocation failure.

This slice has no server composition, HTTP route, Sync v2 or quota enforcement,
Stripe call, charge, cancellation mutation, production schema apply, or
deployment. Before an approved persistent apply, rollback is a reviewed code
revert plus disposable-schema recreation. After any future persistent apply,
close the entitlement consumers, preserve migration 00008 and every projection
and lease record, restore the matching artifact, and verify Billing source
versions before reopening. Never drop entitlement evidence or manufacture an
active projection as part of rollback. T11 owns composition with notes, quota,
and Sync v2; normal cancellation remains dependent on #403 / Draft PR #404.

## T10a terms consent and signup evidence slice

Issue #442 ports the versioned terms disclosure, canonical serialization,
consent planning, current/reconsent/notice decisions, fail-closed application
service, checkout verifier, and signup admission adapter to Go. The shared
`legal/terms-consent.json` fixture includes `<>&` and U+2028/U+2029 and proves
that TypeScript `JSON.stringify` and Go produce the same UTF-8 SHA-256 input.
Unknown fields, trailing JSON, invalid product constants, stale version/hash,
missing affirmation, cross-owner evidence, and undecided changed terms are
rejected.

Migration 00009 stores the complete immutable disclosure snapshot under an
Account/Vault scope. It has submission idempotency, strict shape constraints,
an update-blocking trigger, and an ownership trigger. Because signup records
consent before its Account and Vault exist, that trigger accepts only an exact
existing Personal Vault or the exact signup reservation matching submission,
Account, and Vault. It does not accept client-supplied ownership. Concurrent
identical submissions converge on the first evidence; a retry returns its
original consent ID and timestamp.

Unit and disposable-PostgreSQL tests cover canonical bytes, append/replay,
reconsent classification, dependency failures, checkout verification,
reservation-before-finalization, owner rejection, immutable updates, and a
concurrent one-record race. This slice does not add an HTTP route, terms source
configuration, provider call, public signup, production schema apply, or
deployment. T10 follow-up slices still own legal checkout evidence and the
disconnected GET/POST handler contracts.

Before an approved persistent apply, rollback is a reviewed code revert plus
disposable-schema recreation. After evidence exists, close new signup,
checkout, and reconsent writes; keep migration 00009 and every evidence row;
restore a compatible artifact or use a reviewed forward migration. Never drop,
rewrite, or synthesize consent evidence as part of rollback. T12 must explicitly
apply the approved evidence-retention decision during account deletion.

## T10b commercial contract evidence and checkout orchestration slice

Issue #444 ports the strict legal-commerce decoder, authoritative offer
derivation, JavaScript-compatible canonical JSON and SHA-256 boundary,
affirmative commercial consent plan, immutable evidence application service,
and checkout mapping to Go. The shared `legal/contract-evidence.json` fixture
proves identical TypeScript/Go bytes for Japanese text, `<>&`, and U+2028/U+2029,
as well as the evidence-to-Billing subscription and checkout-intent identifiers.

Migration 00010 stores the complete canonical offer under an Account/Vault
scope, enforces UUID/hash/version/timestamp shape, and rejects UPDATE. The
PostgreSQL repository accepts only an existing exact Personal Vault, scopes all
reads and conflicts by its owner, rejects malformed stored JSON and metadata,
and converges concurrent identical submissions on the first evidence. Its
foreign key deliberately has no implicit delete action: T12 must perform the
reviewed deletion or retention workflow explicitly instead of treating this
migration as permission to erase or indefinitely retain legal evidence.

Checkout orchestration verifies current terms first, records or replays
commercial evidence second, and only then calls the existing Go Stripe Billing
port. Evidence ID becomes the Billing subscription ID; submission ID becomes
the provider idempotency key. On a retry after response loss, the Go path also
reuses the original evidence timestamp. This closes a disconnected TypeScript
edge case where a later server clock could produce a different Billing command
for the same submission and conflict with the pending checkout.

Unit and disposable-PostgreSQL tests cover missing/stale consent, exact replay,
owner isolation, immutable updates, malformed rows, concurrent submission,
dependency/provider failures, provider mapping failures, terms-before-provider
ordering, and response-loss retry. This slice adds no HTTP handler composition,
approved production commerce source, Stripe credentials or network call,
production schema apply, charge, deployment, or public availability. T10c owns
the disconnected Go GET/POST handler and client wire contracts.

Issue #446 resolves the connection blocker without combining legal acts: the
checkout verifier now evaluates the latest immutable evidence in the resolved
Account/Vault scope against the authoritative current terms. The commercial
submission ID remains solely the checkout/evidence/provider idempotency key.
Missing consent and reconsent-required changes fail before commercial evidence
or provider access; a qualified notice-only classification remains non-blocking.

Before an approved persistent apply, rollback is a reviewed code revert plus
disposable-schema recreation. After evidence exists, close new checkout writes,
preserve migration 00010 and all evidence, and restore a compatible artifact or
use a reviewed forward migration. Do not drop, rewrite, or synthesize evidence
as rollback.

## T10c legal HTTP and composition slice

Issue #446 adds Go GET/POST handler factories for
`/api/account/terms-consent` and `/api/billing/checkout`. They derive ownership
only from the Secure session cookie, apply the existing same-origin CSRF rule
before reading unsafe request bodies, enforce an independent 2,048-byte JSON
limit, reject unknown fields and invalid UTF-8, inject clocks and identifiers,
and return the existing fixed no-store/nosniff wire shapes. Dependency panics
are reduced to a fixed log category and a generic unavailable response.

The browser-safe legal identifiers and response decoders now live under
`lib/contracts/`; the terms and billing clients no longer execute
`server/terms-consent` or `server/legal-checkout` modules. The old server public
modules re-export the contract during the comparison period, so existing
reference tests remain usable until T14/T17 removes the TypeScript backend.

`httpapi.HandlerOptions` accepts a separate `LegalRuntime`. A launch-gate
runtime alone cannot expose legal or billing operations. When `LegalRuntime` is
absent, the routes retain the existing legacy-test 404/configured 503 closure;
an incomplete or invalid legal runtime returns 503. The production command does
not construct this runtime because the public origin/auth path, legal source,
pricing, Stripe configuration, and provider credentials are not approved.
Consequently #446 verifies a complete local composition contract without
publishing signup, terms acceptance, Checkout, or charging.

Focused Go tests cover status/acceptance/offer/redirect JSON, owner derivation,
anonymous and cross-site rejection before body reads, 2-KiB and strict-decode
failures, clock/ID/dependency failure, fixed logging, and all stable error
mappings. Legal service tests prove that independent terms and commercial IDs
work, reconsent blocks, and notice-only changes remain allowed. Shared frontend
decoder and architecture tests protect the same wire contract.

Rollback before any approved persistent use removes the `LegalRuntime`
composition and Go handler factories while keeping migrations 00009/00010 and
all evidence. After evidence exists, first stop new terms and checkout writes,
retain both ledgers, restore a compatible artifact or reviewed forward fix, and
keep cancellation/recovery paths available. No rollback step deletes evidence,
changes a legal classification, calls Stripe, or reuses the commercial
submission ID as terms evidence.

## T09d PostgreSQL billing contention hardening

Issue #448 records a timing-dependent defect exposed while verifying #446: a
concurrent billing projection CAS could surface PostgreSQL `40001` directly
instead of returning the repository's `conflict` result. The same commit passed
the work-branch CI, the pull-request rerun, local full verification, and twenty
focused repetitions, which distinguishes the defect from the legal HTTP
changes without dismissing it as harmless test noise.

All billing write methods whose contract returns `CommitKind` now normalize
serialization failures and deadlocks to `conflict`. Their application services
already handle that result as a retryable or stale projection outcome. Other
database errors remain visible and fail closed. No retry loop, provider call,
schema change, route publication, production operation, or relaxed test
expectation is introduced.

## T11a Vault quota policy and PostgreSQL ledger slice

Issue #450 ports the Personal Vault quota policy and durable reservation
ledger to Go without connecting Sync v2 or exposing a route. The pure core
keeps four independent measures: Unicode scalar display characters, exact
serialized plaintext bytes, encoded ciphertext bytes, and HTTP request bytes.
Go rejects invalid UTF-8 before rune counting; a link remains one logical
display item, combining scalars remain separate, and exact documented limits
remain accepted.

Migration 00011 adds owner-scoped usage, reservation, and D1-schema-parity
finalization-assertion tables. PostgreSQL does not need a transient assertion
row: the usage CAS and exact reservation transition run in one serializable
transaction, and either zero affected row rolls the entire transaction back.
The parity table therefore remains empty. Each Vault usage row is locked before
admission or finalization, retryable `40001`/`40P01` outcomes are retried at
most three times, and exhaustion is returned as the stable `cas-conflict`
result. Unrelated database failures remain visible.

Effective usage is committed usage plus only positive pending reservations.
Increasing changes reserve capacity immediately; decreasing updates and
deletes release no capacity until their signed delta is explicitly committed.
The same UUID and SHA-256 fingerprint replays, another fingerprint is rejected,
and successful commit or release advances the usage revision exactly once.
`reconcile_after` only orders owner-scoped investigation candidates; listing
never expires, commits, or releases a reservation.

Pure tests protect scalar counting, independent boundaries, exact limits,
underflow/overflow, replay, release, and revision exhaustion. Disposable
PostgreSQL tests protect owner isolation, the final active-card and byte slot
under concurrent admission, concurrent finalization, decrease/delete timing,
response-loss replay, bounded candidate ordering, malformed rows, and complete
rollback when the reservation update is deliberately reduced to zero rows.

This slice does not add the journal, encrypted-content composition, Sync v2
HTTP handler, browser deletion protocol, automatic reconciler, production
schema apply/backfill, external provider call, deployment, or route
availability. Before any approved persistent apply, rollback is a reviewed
code revert plus disposable-schema recreation. After persistent use, first
stop online mutations, preserve migration 00011 and every pending reservation,
restore a compatible artifact or reviewed forward fix, and reconcile only
against durable content and journal evidence. Never delete or age-release
pending reservations as rollback.

## T11b Sync v2 durable journal and content-index slice

Issue #452 ports the disconnected tenant-scoped Sync v2 journal from the D1
reference to `backend/internal/syncv2` and PostgreSQL. The pure planner retains
the existing card create/update, conflict create/resolve, and card-delete
state transitions. It allocates Vault-local display IDs and contiguous change
sequences, orders conflict tombstones before the final card tombstone, and
returns a durable receipt on exact mutation/fingerprint replay. Reusing a
mutation ID with another fingerprint remains rejected.

Migration 00012 adds owner-scoped allocator state, card/conflict indexes,
receipts, and change descriptors. It stores no title, body, link, plaintext,
ciphertext, wrapped key, billing, or provider data. Encrypted payloads continue
to belong to the migration 00005 immutable-object repository. The later T11c
application service must use that repository and this journal rather than add
a second content store.

Each commit uses one serializable PostgreSQL transaction plus a Vault-scoped
advisory lock. Card/conflict index changes, the receipt, ordered journal rows,
and allocator advance either all commit or all roll back. Serialization and
deadlock failures retry at most three attempts; exhausted concurrency is a
visible `cas-conflict`, while unrelated database failures remain visible. A
second Account cannot open a mismatched Vault, and every query uses the
captured Account/Vault scope.

The first read captures `next_change_sequence - 1`; continuations retain that
high watermark and use a 501-row lookahead to return at most 500 descriptors.
Invalid windows, malformed rows, and sequence gaps fail closed. Tests cover
the complete seven-change lifecycle, response-loss replay, identical IDs in
different Vaults, competing revisions, injected journal-insert rollback, an
exact 500-item page, and exclusion of a new edit from an existing snapshot.

This slice does not publish the Sync v2 route, hydrate encrypted content,
connect authentication/entitlement/quota, backfill D1, run a production
migration, or create a provider resource. Before a persistent apply, rollback
is a reviewed code revert and disposable-schema recreation. After any future
approved apply, first stop Sync v2 writes, preserve migration 00012 receipts
and sequences together with migration 00005 objects and migration 00011 quota
reservations, and restore a compatible artifact or reviewed forward migration.
Dropping the journal or reusing sequences is not a safe rollback.

## T11c authenticated Sync v2 composition slice

Issue #454 composes the previously disconnected Go building blocks without
publishing `/api/v2/sync`. `backend/internal/syncv2` now owns strict request,
stored-content, response, and cursor codecs; canonical SHA-256 mutation and
deletion fingerprints; pure mutation/hydration planning; and the application
service. HMAC-SHA-256 cursors bind an exact Vault, device, after position, and
high watermark. Continuation at a terminal watermark deliberately captures a
new snapshot; a nonterminal continuation retains its original snapshot.

The application opens the PostgreSQL journal and quota ledger with the
server-derived Account/Vault scope and opens encrypted content only after the
same owner check. It reserves quota, writes or replays one immutable encrypted
object, commits or replays the journal receipt, and then finalizes quota. A
matching receipt retry completes an interrupted quota finalization without a
second encryption or object upload. Upserts hydrate the exact encrypted
revision named by the journal; tombstones do not read an object. Card deletion
uses the same canonical fingerprint, reads the current encrypted revision,
commits revisioned tombstones, and releases usage only after journal success.

`backend/internal/httpapi/sync_v2.go` authenticates the secure session and
same-origin request before reading the bounded body, then checks `notes-sync`
and server-read Personal Vault limits. It returns only fixed `no-store` error
categories. The handler constructor is intentionally absent from
`HandlerOptions`, so the current public route still returns the pre-existing
closed 404/503 contract. No cursor secret, object service, production keyring,
provider resource, route switch, or deployment is selected by this slice.

Unit evidence covers duplicate/unknown JSON, Unicode/canonical bytes, cursor
tampering, mutation planning, exact-revision hydration, authorization-before-
body, entitlement/application mappings, and malformed or oversized requests.
The disposable PostgreSQL vertical test runs session authentication,
Entitlement, quota, envelope encryption, immutable object metadata, journal,
response encoding, and cursor continuation. It injects a failure after the
encrypted object commit and before the journal commit, proves the reservation
stays pending, and proves an identical retry finishes without repeating the
external write. It also covers ciphertext/plaintext separation, MutationId
reuse, cross-owner and cross-device denial, deletion replay, quota release,
and tombstone delivery. The exact 10,000-card concurrent final-slot proof
remains in the T11a ledger test and is exercised by the same adapter used here.

Before any persistent use, rollback is a code revert while the handler remains
unmounted and the disposable schema may be recreated. After accepted writes,
first stop Sync v2 mutations and preserve migrations 00005, 00011, and 00012,
their object bytes, keyrings, reservations, receipts, and sequence state as one
consistency set. Restore a compatible artifact or apply a reviewed forward
fix; never delete pending reservations or immutable objects merely to roll
back application code.

## T12a privacy request journal and closed HTTP contract

Issue #456 ports the existing provider-neutral privacy request journal to
`backend/internal/privacyrequest`. Pure transitions preserve the exact
verification-pending, ready, processing, completed, rejected, failed, and
retryable-failure lifecycle. Strict request and public-response codecs reject
duplicate or unknown members, trailing values, invalid UTF-8, unpaired
surrogates, malformed UUIDv7 identifiers, unsafe timestamps, and owner fields
in public responses. The shared account lifecycle fixture is decoded by both
the TypeScript client and Go.

Migration 00013 adds an empty owner-scoped PostgreSQL journal. An insert-time
trigger requires an exact current Personal Vault owner, while the table has no
owner foreign key so a previously accepted deletion request can remain
trackable after live Account/Vault removal. Scoped request/submission
uniqueness, compare-and-swap revisions, state-shape checks, and boundary
decoding provide replay, conflict, and malformed-row protection. This shape is
not a retention decision.

The application keeps verification, non-deletion fulfillment, and the
existing account-deletion handoff as separate ports. A request cannot execute
before verification; a concurrent processing claim runs at most one effect;
provider failure records only a redacted failure code and retryability. A
deletion request cannot pass through the generic fulfillment port and can only
complete with `account-deletion-started` after the typed handoff succeeds.

`backend/internal/httpapi/privacy_request.go` authenticates the secure session
and same-origin request before reading the bounded body and returns only fixed
`no-store` categories. Its constructor is intentionally absent from
`HandlerOptions`, so both public routes retain the existing closed 404/503
contract. The slice does not choose identity verification, fulfillment,
retention, a provider, or recovery for a permanently processing request. It
does not incorporate the still-draft normal-cancellation policy from #404;
T12b owns the account-deletion saga and that overlap.

Before any persistent use, rollback is a code revert while the handler remains
unmounted and the disposable schema may be recreated. After an accepted
request exists, first stop new submissions and processing, preserve migration
00013 and every journal revision, restore a compatible artifact or apply a
reviewed forward fix, and resume from durable state. Never drop an accepted
request or synthesize verification, execution, deletion, or completion
evidence as rollback.

## T12b account-deletion saga, capability, and closed HTTP

Issue #458 ports the fixed five-step deletion state machine to
`backend/internal/accountdeletion`. Pure plans own claims, lease recovery,
bounded retry, terminal failure, exact prefix receipts, and public status.
Strict codecs share the account lifecycle fixture with TypeScript and reject
unknown or duplicate members, invalid UTF-8 or surrogate escapes, unsafe
integers, forged owner fields, malformed tokens, and terminal responses that
retain a capability.

Migration 00014 adds PostgreSQL operations, step receipts, and digest-only
continuations. New operations require an exact current Personal Vault owner,
but the minimal operation journal has no live-owner foreign key so it survives
the final live-state removal. Repository compare-and-swap consumes every fresh
continuation sequence before work, permits only the immediately prior sequence
as response-loss replay, and commits state plus a successful receipt in one
transaction. Tests cover concurrent sequence and revision claims, cross-owner
denial, credential conflict, replay, malformed rows, and journal survival.

The application receives mandatory policy and one typed port for each ordered
effect: all-session revocation, immediate subscription cancellation, Vault
live-data purge, private-object purge, and account finalization. Only a newly
applied step claim dispatches an effect. External errors are reduced to a
non-sensitive failure code; operation ID plus step is the stable adapter
idempotency identity. The HMAC credential adapter binds its derivation to the
stored owner scope and never persists or logs the client secret.

The start HTTP contract authenticates owner and CSRF before reading its bounded
body, then persists the initial operation without revoking the session or
clearing the cookie. The continuation contract requires CSRF but not the live
session, consumes a sequence, runs at most one effect, and clears the stale
cookie only for an accepted response. Both handlers remain outside
`HandlerOptions`; production routes remain closed.

This slice intentionally does not compose any destructive effect. Contract
evidence currently provides a fail-closed foreign-key hold, and its retention
or deletion policy still requires the legal/operational decision recorded in
`docs/go-migration-decisions.md`. Immediate deletion cancellation remains
distinct from the normal period-end cancellation in Draft PR #404. No Stripe,
object store, KMS, email, production database, public route, or deployment is
selected or changed.

Before persistent use, rollback is a code revert and recreation of only the
disposable test schema. After an accepted operation exists, stop new starts,
preserve migration 00014 with every operation/receipt/continuation row, restore
a compatible artifact or apply a reviewed forward migration, and resume from
the durable capability. Code rollback cannot restore revoked sessions,
cancelled subscriptions, deleted data, or finalized accounts and must never
synthesize a receipt.

## T12c session revocation and immediate Billing cancellation effects

Issue #460 ports the first two concrete saga effects without connecting the
closed deletion HTTP handlers. `StepEffectInput` now carries the stable prior
receipt time separately from the current execution time. Session revocation
uses the execution time, while provider cancellation uses the operation ID and
prior receipt time as stable idempotency inputs across response loss.

PostgreSQL session issuance, rotation, and account-deletion start serialize on
the same exact Personal Vault owner row. An operation that already exists
blocks new or rotated sessions. If issuance commits first, deletion start
follows and the first revocation attempt removes it. Integration tests also
cover a later session causing a retry, zero-session replay, and cross-owner
terminal denial.

The Go Billing cancellation service resolves only the persisted owner-scoped
provider mapping. It validates a typed provider observation and never mutates
the ordinary Billing projection; verified webhooks and reconciliation remain
authoritative. The pinned Stripe SDK method is covered with a local HTTP stub,
including DELETE routing, API version and idempotency headers, no invoice or
proration request, malformed output, terminal 4xx, and retryable 429/5xx. No
real provider credentials or calls are used, and runtime composition remains
closed.

Rollback stops future attempts but cannot restore a revoked session or an
externally cancelled subscription. Preserve the saga journal and provider
idempotency identity, restore a compatible artifact, and resume. Never rewrite
the Billing projection or synthesize cancellation evidence during rollback.

## T12d Vault live-data purge and deletion write gate

Issue #462 ports `delete-vault-data` without connecting the closed deletion
HTTP handler. `backend/internal/vaultdata` owns typed, provider-neutral purge
results and deterministic result evaluation. The account-deletion effect maps
those results to fixed non-sensitive failure codes and supplies the prior
subscription-cancellation receipt time as the stable delete-outbox creation
time.

Migration 00015 installs a PostgreSQL write gate on mutable Vault crypto,
encrypted-object, quota, and sync-v2 rows. Each insert or update first locks
the exact Personal Vault row and then checks the durable deletion journal. A
write that holds the lock first must commit before deletion can start, so the
later purge observes it. If deletion starts first, the write resumes only
after the operation is durable and is rejected. Delete-outbox processing,
Billing updates, legal evidence, privacy journal transitions, saga progress,
and finalization deletes are deliberately outside this gate.

The serializable purge transaction locks the exact Account/Vault owner, moves
every committed metadata key and pending-write key into the durable scoped
delete outbox, deletes a source row only when its matching outbox row exists,
and then removes scoped sync-v2 and quota live rows. A cross-Vault object-key
collision is terminal and rolls back without deleting either owner's rows.
Before mutation it also verifies the exact running deletion operation and the
stored subscription-cancellation receipt time. The transaction verifies zero
live inventory before commit. A response-loss retry returns `already-purged`
and never changes an existing outbox row's creation time.

The purge preserves physical private objects and their outbox inventory,
wrapped DEKs and rotation state, Account/Personal Vault/identity rows, Billing
and Entitlement state, immutable legal evidence, privacy requests, and the
deletion journal. Legacy v1 tables are global rather than owner-scoped and are
not guessed or opportunistically removed. No object store, KMS, Stripe,
production database, public route, deployment, or `main` change is selected or
performed.

Rollback stops new purge attempts and restores a compatible artifact while
retaining migration 00015, the deletion journal, and every outbox row. It must
not re-enable Vault writes for an owner whose deletion has started. Live rows
already committed as deleted are not reconstructed; private-object processing
resumes from the retained outbox. Dropping the write gate while such an
operation exists is unsafe and requires a reviewed forward recovery instead.

## T12e private-object purge

Issue #464 ports `delete-private-objects` without connecting the closed
account-deletion HTTP handler or adding a production object-storage adapter.
`backend/internal/encryptedobject` owns the typed policy, command, outbox
contracts, deterministic evaluation, and provider-neutral result. The
account-deletion effect passes the exact operation ID, prior
`delete-vault-data` receipt time, and current injected execution time, then
maps results to fixed non-sensitive failure codes.

The PostgreSQL directory fails closed unless the exact Account/Vault owner is
retained and that exact operation is running the private-object step with the
matching prior receipt. Inventory reads and compare-and-swap mutations recheck
the authorization. Only opaque keys already present in the scoped durable
outbox can reach the storage port; request data, guessed keys, metadata, and
list results cannot add deletion targets.

Each call selects a bounded due batch. Storage `deleted` and idempotent
`not-found` both permit confirmation. A storage failure preserves the row,
increments its attempt, and schedules the configured retry while already
successful rows stay complete. Confirmation and reschedule mutations compare
the prior attempt count; missing rows are concurrent replays, changed rows are
conflicts, and the step succeeds only after a scoped post-count is zero. The
pre-existing generic PostgreSQL outbox methods now also reject zero-row CAS
mutations instead of silently succeeding.

Tests use only independent in-memory object stores plus the disposable
PostgreSQL test database. They cover owner/operation/receipt rejection,
bounded and empty replay, partial storage failure and backoff, an object
deleted before PostgreSQL confirmation fails, `not-found` recovery, CAS
conflict, another Vault, and preserved wrapped keys/control-plane/Billing/legal/
privacy/saga data. No production bucket, credential, provider call, migration,
route, deployment, or `main` change is selected or performed.

Rollback stops future attempts and restores a compatible artifact while
retaining every pending outbox row and the account-deletion journal. Objects
already deleted are not recreated; a retained row safely resumes through
`not-found`. T12f owns the later wrapped-key, legal-evidence, and owner
finalization barriers; privacy handoff remains separate.

## T12f policy-gated account finalization

Issue #466 ports `finalize-account` without composing the closed deletion HTTP
handler or selecting a production legal-evidence policy. The pure Go service
requires an explicit `undecided` or `delete-live-evidence` policy and runs four
ordered barriers: private-object outbox reconfirmation, legal-evidence policy,
wrapped DEK metadata removal, and live control-plane deletion. `undecided`
stops an evidence-bearing operation before either destructive stage. The
delete-live branch is only a locally tested candidate and is not a legal,
production, or deployment decision.

The PostgreSQL adapter requires the exact Account/Vault owner, running
operation, matching prior completion time, and an exact ordered set of the four
preceding receipts. Wrapped-key removal and live-state removal use separate
serializable transactions so a control-plane failure rolls back all evidence
and owner changes while a retry recognizes already-removed wrapped metadata.
The live transaction explicitly removes sessions, identities, verified-email
ownership, and the finalized signup reservation before deleting the Personal
Vault and Account; Billing and Entitlement rows then cascade from the Vault.
Deleting the signup reservation deliberately fixes a TypeScript omission that
could retain email/provider uniqueness and block legitimate later
re-provisioning.

Migration 00016 serializes terms/contract evidence insertion and deletion start
on the Personal Vault row. Evidence committed first remains visible to the
policy barrier. Once the deletion journal is durable, new evidence insertion is
rejected, closing the policy-check/wrapped-key race. The minimal deletion and
privacy journals remain independent and survive owner removal.

Disposable-PostgreSQL tests cover a pending policy, delete-live candidate,
private-object barrier, missing/wrong receipts, wrong operation and owner,
legal-evidence write rejection, transaction rollback, retry after partial
progress, complete response-loss replay, another tenant, retained journals,
and failed old identity/session lookups. No KMS provider is called and no
production migration, object store, credential, public route, deployment, or
`main` change is selected or performed.

Rollback first stops finalization attempts and preserves migrations 00014-00016
plus every operation, receipt, continuation, privacy journal, and pending
outbox row. It must not drop the legal-evidence gate while an operation exists.
Already removed keys, evidence, or live owner rows are not reconstructed;
restore a compatible artifact or apply a reviewed forward fix and resume. A
production legal-evidence choice, backup expiry, and provider-key destruction
remain separately approved operations.

## T12g privacy deletion handoff composition

Issue #468 connects only the existing `privacyrequest.DeletionHandoffPort` to
the existing Go account-deletion `Start` application. The adapter derives a
domain-separated, owner-bound idempotency key from the verified Account/Vault
scope and privacy request ID. It also derives a tenant-isolated UUIDv7 operation
ID: the source request's timestamp prefix is preserved, while the remaining
bits are a scoped digest with the UUID version and variant bits restored. The
same owner/request therefore replays one operation, while two owners may safely
use the same privacy request ID without colliding in the deletion journal.

Only an accepted account-deletion result with a valid public response becomes
`account-deletion-started`. Credential conflicts and invalid inputs become
fixed terminal failure codes; dependency failures become a fixed retryable
code. Provider or database error text is never copied into the privacy journal.
The account-deletion application stores the operation and digest-only
continuation atomically. The privacy handoff does not consume that continuation
or dispatch a saga step, and it never exposes or logs the returned capability.

PostgreSQL coverage runs privacy submit, verification, processing, and the real
account-deletion start repository together. It proves a lost handoff response
can replay the same durable start, the operation and continuation remain
singletons, another owner is isolated, a pre-existing conflicting owner
operation is preserved, and no deletion effect is invoked. The public privacy
and deletion routes remain closed, so this is composition evidence rather than
feature publication.

`account-deletion-started` is not a statement that data has been deleted. The
explicit runner that advances the stored saga remains T13 work. Recovery for a
privacy record left permanently in `processing`, identity-verification and
non-deletion fulfillment providers, privacy/evidence retention, the production
legal-evidence policy, and every production configuration remain undecided and
closed. Rollback stops new privacy processing but preserves migrations
00013-00016, both journals, continuation digests, receipts, and outbox state; it
does not delete a started operation or synthesize a privacy completion.

## T13a scoped quota reconciliation audit runner

Issue #470 adds the first explicit non-HTTP operations entry point. The
`notesctl quota reconcile-list` command requires an exact execution
environment, Account/Vault scope, as-of timestamp, and limit from 1 through 100. The application validates those values before database access. The
PostgreSQL adapter verifies the exact owner relation and lists only due
`reserved` rows in stable `(reconcile_after, reservation_id)` order without
creating quota usage, finalizing a reservation, or changing any row.

Output is bounded JSON evidence containing the command kind, as-of timestamp,
count, reservation IDs, and reconciliation timestamps. It intentionally omits
the Account/Vault IDs, card IDs, fingerprints, quota values, content, database
URL, credentials, and dependency error text. Repeating the command with the
same scope, timestamp, and limit returns the same ordered snapshot unless an
independent writer changes the ledger. Process interruption cancels the query
and cannot become partial success.

Local and test execution accepts only the existing loopback allowlisted
disposable PostgreSQL database. Production command construction additionally
requires `--confirm-production-read-only`, but that flag is an accidental-run
guard, not authorization: connecting to or reading a production/shared
database still requires the user's separate explicit approval. Quality and the
Issue tests use only disposable PostgreSQL.

This command never infers that an expired reservation should be committed or
released. T13b adds a separate evidence-confirmed commit; automatic release,
scheduling, HTTP/UI exposure, and all other T13 runners remain separate work.
Operational invocation and rollback details are in
[`go-operations.md`](go-operations.md).

## T13b evidence-confirmed quota commit runner

Issue #472 adds `notesctl quota reconcile-commit` for one exact Account/Vault
scope and reservation. The pure operations policy requires a valid due
reservation and a durable Sync v2 commit receipt whose mutation ID,
fingerprint, card ID, and original commit/request timestamp all exactly match
the reservation. Missing or mismatched evidence, cross-owner access, a future
reconciliation time, an unknown reservation, or a released reservation is a
refusal without a ledger mutation. Age alone is never positive or negative
evidence, so this slice deliberately adds no release path.

The PostgreSQL adapter reads only those two durable records, then locks and
revalidates the receipt inside the same serializable transaction that updates
the existing quota ledger. Evidence removed after the first read fails closed.
The ledger's scoped CAS makes retries replay-safe and concurrent identical
attempts produce one commit and one replay with a single usage revision
advancement. The operations layer accepts only the current paid Personal Vault
limit policy; operator-supplied limits are intentionally unavailable until a
durable per-owner limit version exists.

CLI parsing requires `--confirm-durable-sync-receipt` before any dependency is
called. Production command construction also requires
`--confirm-production-mutation`, but the flags are only accidental-run guards
and do not authorize a production connection or write. Local and test
execution remains restricted to the existing loopback disposable database.
Output omits database configuration, owner scope, fingerprints, card IDs,
quota values, and dependency error details. There is no HTTP/UI route,
scheduler, provider request, schema change, external resource, or production
execution in this slice.

Rollback stops the runner and reverts the application artifact. A completed
quota commit is an intentional replayable ledger transition backed by the
immutable Sync receipt; rollback must preserve it rather than delete or
fabricate rows. Automatic release, recurring scheduling, remaining T13
runners, and production operations remain separate work.

## T13c scoped account-deletion audit runner

Issue #474 adds `notesctl account-deletion inspect` for one exact Account/Vault
scope and operator-supplied observation timestamp. The operations policy
exhaustively maps the existing durable saga states into due/waiting, active or
expired lease, retry waiting/due, terminal failure, and completed audit states.
It validates the stored snapshot and exact owner scope before returning any
result. Unknown and cross-owner scopes share one refusal and expose no stored
operation identity.

The PostgreSQL composition reuses the existing owner-scoped deletion
repository. It performs no continuation consumption, compare-and-swap, step
claim, session revocation, provider call, Vault/object/key deletion, or account
finalization. Integration coverage verifies every persisted state used by the
runner and checks that operation, receipt, and continuation counts remain
unchanged. Cancellation and malformed state fail without a success document.

CLI output is deliberately limited to operation ID, mapped state, current step
when present, readiness, the relevant stored timestamp, and the supplied
observation timestamp. It omits owner IDs, continuation material, failure
codes, billing references, content, configuration, and dependency errors.
Local/test targets remain restricted to the loopback disposable database.
Production syntax has a read-only confirmation guard, but no production or
shared database was accessed and the guard is not authorization.

This audit does not advance deletion. The single-step runner still needs
separate composition review for Stripe cancellation, private object storage,
and the production legal-evidence policy. Rollback stops the read-only command
and reverts the application artifact; there is no data effect to undo and the
durable saga journal must remain intact.
