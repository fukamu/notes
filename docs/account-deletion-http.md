# Account deletion HTTP boundary and continuation capability

Issue #174 exposes provider-neutral handlers for starting and resuming the
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
