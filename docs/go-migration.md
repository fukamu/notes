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
- T07 envelope encryption, GCP Cloud KMS boundary, and wrapped-DEK keyring are
  Issue #428 on `work/428-go-envelope-kms-keyring`, branched from that exact
  integration commit. They remain disconnected and do not select a production
  KMS resource, create credentials, expose content routes, or activate paid
  provider use.
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
| F01 | A     | page delivery / SSR-RSC removal             | T05                             | V01,V10      | integrated by #420 / PR #421                 |
| F02 | B     | launch gate / private owner                 | T04                             | V02,V03      | signed gate #416; owner/origin enforced #418 |
| F03 | A     | legacy sync                                 | T04                             | V01,V04,V10  | Go/Postgres #418; Go-served UI #420          |
| F04 | B     | session / CSRF                              | T06                             | V02,V03,V04  | Go core/Postgres integrated by #422          |
| F05 | B     | Google OIDC                                 | T06                             | V03          | Go core/provider adapter #424; disconnected  |
| F06 | B     | email OTP                                   | T06                             | V03          | Go core/HMAC/CAS #426; disconnected          |
| F07 | B     | identity / vault context                    | T06                             | V03,V04      | session #422; persistent directories #426    |
| F08 | B     | signup admission                            | T06,T10                         | V03,V07      | atomic Go provisioning #426; terms port open |
| F09 | B     | vault content                               | T11                             | V04,V05      | pending                                      |
| F10 | B     | sync v2                                     | T11                             | V01,V04,V05  | contract captured in #410                    |
| F11 | B     | envelope encryption                         | T07                             | V06          | Go AES-GCM/fixture implemented by #428       |
| F12 | B     | KMS / DEK                                   | T07                             | V06,V09      | Go local boundary #428; external proof open  |
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
| V03 | session/OIDC/OTP/owner/CSRF failures                    | session/CSRF #422; OIDC #424; OTP/owner #426                  |
| V04 | empty Postgres, transactions, concurrency, rollback     | #414/#418 plus signup atomicity/replay/conflict #426          |
| V05 | sync/quota paging, retry, conflict, limits              | pending T11                                                   |
| V06 | crypto vectors, tamper/AAD/KMS failures                 | TS/Go vector, tamper/AAD/CRC/timeout in #428; T08 pending     |
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
