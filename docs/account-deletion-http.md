# Account deletion HTTP boundary and continuation capability

## Go migration status (T12b/T12h)

`backend/internal/httpapi/account_deletion.go` is connected only by the exact
disposable `local-fixture` composition. The connection requires
`NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY=delete-live-evidence`; an omitted or
`undecided` value leaves both routes unmounted. Default and production-shaped
profiles also leave the runtime absent and fail closed. This fixture selection
is deletion evidence, not legal approval, production configuration, or
deployment authorization.

The start handler authenticates the secure session and same-origin metadata
before reading the 2,048-byte bounded body. It stores only the operation and
continuation and does not clear the cookie or execute `revoke-sessions`. The
resume handler requires same-origin CSRF metadata but no live session, consumes
the capability sequence, executes at most one step, and clears the stale
session cookie only after an accepted response. Both use strict codecs and
fixed, redacted errors; logs never include the continuation capability.

`backend/internal/adapters/accountdeletioncredential` uses an injected
minimum-256-bit HMAC key. Domain-separated, length-framed inputs bind the
idempotency credential and derived continuation secret to the Account/Vault
scope. PostgreSQL stores only the HMAC idempotency digest and SHA-256 secret
digest. The adapter reads no environment and copies caller-owned key bytes.

All five ordered Go effect boundaries are connected to the one seeded
Account/Vault through scoped PostgreSQL adapters, a no-network cancellation
provider, anchored local filesystem deletion, and the finalization barrier.
The shared Vault activity fence seals before Start waits for active sync and
remains sealed after an accepted or potentially committed Start. Sync cannot
overtake deletion. A fixed host-local lock plus a PostgreSQL advisory lock
exclude cooperating Notes and `notesctl prepare-e2e` processes for the lifetime
of the runtime. Readiness and every deletion application call recheck the
PostgreSQL keeper; loss fails closed without releasing the host lock.

The host directory and lock file are anchored by open handles and exact
device/inode, owner, mode, and link-count checks. The fixture assumes
cooperating same-UID Notes/notesctl processes do not rename or unlink that lock
namespace. A same-UID adversary can already mutate the disposable database and
private fixture directly and is outside this development-only boundary.

Issue #468 adds a separate internal start caller for an already verified
privacy deletion request. It derives a stable owner/request identity, stores or
replays the same operation and continuation, and stops before consuming the
continuation. It neither mounts these HTTP handlers nor substitutes for the
browser continuation flow. The privacy outcome `account-deletion-started`
therefore means only that the durable saga exists. It is not connected to this
local fixture HTTP/browser path.

Go migration `00014_account_deletion_saga.sql` adds operation, receipt, and
continuation storage together. Exact startup preflight classifies the whole
41-table database plus private filesystem as pristine, deleting, or completed;
unknown rows, owners, files, modes, links, metadata, or phase combinations stop
startup. A deleting or completed restart additionally requires the explicit
delete-live policy, so a missing/undecided restart cannot silently strand the
saga behind a 404.

## Frozen TypeScript/D1 contract (historical)

The remainder preserves the retired TypeScript/D1 wire contract as historical
parity and rollback evidence; it is not an executable server path. Issue #174
introduced the original provider-neutral handlers for starting and resuming the
account-deletion saga. At retirement those handlers required complete D1,
subscription-cancellation, private-object, encryption, and credential
composition; the legacy test mode returned 404 and other unconfigured modes
returned 503. The Go handler is now the sole executable implementation and is
composed only by the exact disposable fixture described above.

## Request order

`POST /api/account/deletion` requires the secure session cookie, same-origin
CSRF metadata, and this exact JSON body:

```json
{ "idempotencyKey": "43-character unpadded base64url value" }
```

The handler derives AccountId and VaultId exclusively from the authenticated
session. Unknown body fields are rejected, so an AccountId or VaultId supplied
by a caller is never accepted. Billing entitlement is deliberately not checked:
a payment-locked account remains allowed to leave.

Start atomically stores the initial revoke-first operation and its continuation
record before responding. It does not revoke the session in that request. This
ordering prevents a lost start response from removing the only credential the
browser can use to finish deletion. A retry with the same high-entropy
idempotency key returns the same operation capability; another key conflicts.

`POST /api/account/deletion/status` requires same-origin CSRF metadata but does
not require a live session. Its exact body is:

```json
{ "continuationToken": "ad1.<43-character secret>.<sequence>" }
```

A valid resume response clears the old session cookie. Each fresh sequence is
consumed with PostgreSQL compare-and-swap before at most one saga effect is dispatched.
The first effect is therefore always all-session revocation. Later requests run
subscription cancellation, live PostgreSQL purge, private object deletion, and account
finalization in the receipt-enforced order implemented by Issues #168–#173.

## Capability handling

The client-visible secret is deterministically derived by keyed HMAC from the
session-derived owner scope and the high-entropy idempotency key. The database
stores only SHA-256 digests of the idempotency key and derived secret. Neither
plaintext value, Account/Vault identity, user content, provider details, nor
failure details are returned by status responses.

Continuation lifetime and step lease duration are mandatory injected policies.
The fixture issues an initial seven-day capability. An expired token,
unknown digest, future sequence, or a sequence older than the immediately prior
one is rejected with the same generic response. The immediately prior sequence
may recover the current token after a response is lost, but it never dispatches
an effect again. This bounded replay recovery avoids both duplicated deletion
effects and an unrecoverable operation caused by a lost HTTP response.

Before revocation is claimed, an expired capability can be recovered only
while a live authenticated session in the same Account/Vault owner scope
remains available. The browser accepts only
the exact `continuation-required` Resume denial (not an arbitrary or malformed
401), replays authenticated Start with the marker's same idempotency key, and
persists the returned capability with marker compare-and-swap before trying
Resume again. PostgreSQL atomically extends expiry only when the stored
operation is still the exact initial `Ready(revoke-sessions, attempt=0)` state
with zero receipts and the owner/idempotency/derived secret match. The secret
and sequence are preserved, so the token can remain byte-identical. Ordinary
Start replay before the exclusive expiry boundary is read-only and never
slides the original seven-day window; a lost renewal response inside the new
window is likewise idempotent and leaves that newly committed expiry intact.
Another owner/key, the absence of a live session in that scope, or any claimed/receipted operation
cannot renew through Start and causes no mutation.

The durable claim of `revoke-sessions` is the irreversible admission boundary.
In that same transaction, after consuming a valid initial token and before the
revocation effect, PostgreSQL promotes only that operation's continuation
expiry to `Number.MAX_SAFE_INTEGER`. This closes both claim-before-effect and
effect-before-receipt crash windows after the live session disappears. The
credential cannot start another deletion or read Account/Vault data; it can
only resume and report the already-authorized saga, and the current or
immediately previous sequence retains the normal replay rules.

Public states are limited to `in-progress`, `retry-wait` with a retry timestamp,
`failed`, and `completed`. Terminal responses contain no continuation token.
All responses are `Cache-Control: no-store` and `X-Content-Type-Options:
nosniff`.

## Migration and rollback

The historical D1 migration `0010_account_deletion_continuation` and current Go
migration 00014 both model an operation-owned
continuation table and expiry/secret-hash indexes. It has no Account/Vault
foreign key, so finalizing live control-plane state does not destroy the
capability needed to receive the terminal response. It contains no content or
provider secret. No migration is applied to production by this work.

Rollback disables new HTTP starts but must keep a compatible Resume/status path
for every accepted operation. Preserve migrations 00014-00016, operation,
receipt, continuation, outbox, and privacy journal rows, plus residual fixture
files. Restore a compatible artifact or apply a reviewed forward fix and resume
with the stored browser capability. Never synthesize a receipt or try to
restore revoked sessions, cancelled subscriptions, deleted objects, wrapped
keys, or finalized owners. Only the explicitly reviewed disposable
prepare/reseed procedure may replace an intentionally disposable fixture; it
is not a production recovery mechanism.
