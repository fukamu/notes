# Account deletion HTTP boundary and continuation capability

## Go migration status (T12b)

`backend/internal/httpapi/account_deletion.go` now implements the same two
contracts as disconnected Go handlers. Its runtime is deliberately absent from
`HandlerOptions`; therefore the real routes keep their existing 404/503
behavior and cannot select a fake or partial deletion composition.

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

All five ordered Go effect boundaries now have local implementations, including
the T12f policy-gated finalizer. This does not remove the composition hold:
`HandlerOptions` still has no deletion runtime, the legal-evidence policy has no
approved production selection, and no provider credentials or destructive
route are enabled.

Go migration `00014_account_deletion_saga.sql` adds operation, receipt, and
continuation storage together because no Go route is enabled between partial
schema stages. Before persistent use, rollback may recreate only the disposable
test database. Once an operation is accepted, rollback must first close new
starts, preserve migration 00014 and all journal rows, restore a compatible
artifact or apply a reviewed forward fix, and resume using the stored
capability. It must never synthesize receipts or attempt to undo an external
effect.

The remainder documents the existing TypeScript/D1 compatibility contract.

Issue #174 exposes the original provider-neutral handlers for starting and resuming the
account-deletion saga. The public production routes remain fail closed until a
composition root supplies every real D1, subscription cancellation, private
object, encryption, and credential binding. Legacy test mode returns 404 and
other unconfigured modes return 503; neither route selects a fake adapter.

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
consumed with D1 compare-and-swap before at most one saga effect is dispatched.
The first effect is therefore always all-session revocation. Later requests run
subscription cancellation, live D1 purge, private object deletion, and account
finalization in the receipt-enforced order implemented by Issues #168–#173.

## Capability handling

The client-visible secret is deterministically derived by keyed HMAC from the
session-derived owner scope and the high-entropy idempotency key. The database
stores only SHA-256 digests of the idempotency key and derived secret. Neither
plaintext value, Account/Vault identity, user content, provider details, nor
failure details are returned by status responses.

Continuation lifetime and step lease duration are mandatory injected policies;
this Issue does not silently choose production durations. An expired token,
unknown digest, future sequence, or a sequence older than the immediately prior
one is rejected with the same generic response. The immediately prior sequence
may recover the current token after a response is lost, but it never dispatches
an effect again. This bounded replay recovery avoids both duplicated deletion
effects and an unrecoverable operation caused by a lost HTTP response.

Public states are limited to `in-progress`, `retry-wait` with a retry timestamp,
`failed`, and `completed`. Terminal responses contain no continuation token.
All responses are `Cache-Control: no-store` and `X-Content-Type-Options:
nosniff`.

## Migration and rollback

Migration `0010_account_deletion_continuation` adds an operation-owned
continuation table and expiry/secret-hash indexes. It has no Account/Vault
foreign key, so finalizing live control-plane state does not destroy the
capability needed to receive the terminal response. It contains no content or
provider secret and is applied only through the explicit production migration
manifest; this work does not apply it to production.

Rollback disables new HTTP starts while preserving operation, receipt, and
continuation rows for an internal runner or a corrected handler. It does not
attempt to restore revoked sessions, cancelled subscriptions, deleted objects,
wrapped-key metadata, or finalized accounts.
