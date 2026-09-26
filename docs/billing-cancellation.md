# Go subscription cancellation contract

Issue #496 ports the ordinary cancellation contract captured in Draft PR #404
into the Go migration branch. The draft head reviewed for this port was
`0c64fe6f4f522ec049e5589a2d292adc97a16724`. This is migration compatibility
evidence only: it does not merge or retarget #404, approve a product policy,
publish `/api/billing/cancel`, configure a Stripe key, make a provider request,
start charging, change production data, deploy, or update `main`.

## Separate effects

`billing.CancellationService` exposes two narrow ports over one owner-scoped
repository and provider adapter:

- `ScheduleSubscriptionCancellation` is the ordinary user action. It requests
  `period-end` and confirms only a provider `scheduled` response, or an
  already-cancelled subscription.
- `CancelSubscriptionImmediately` is reserved for account deletion. It
  requests `immediate` and confirms only `cancelled` or `already-cancelled`.

The caller supplies Account/Vault scope, an opaque idempotency key, and a
timestamp. The persisted Billing row supplies the provider subscription
reference, so neither the request body nor another feature can select a Stripe
subscription. A locally projected future `cancelAt` completes only the
period-end operation; account deletion still requests immediate cancellation.

Confirmed results carry both `confirmedAt` and provider-confirmed
`accessEndsAt`. A period-end schedule requires access to end no earlier than
both the provider observation and request. Immediate and already-cancelled
results require access to have ended no later than the observation. A replay
may return the original observation timestamp, so the core does not require
every observation to be newer than a later retry clock. Provider identity,
subscription reference, and idempotency key must still match exactly.

Cross-effect output, malformed output, response loss, and provider
unavailability are retryable and cannot confirm cancellation. Invalid owner or
subscription state, missing persisted mapping, and terminal provider rejection
fail closed. The direct provider effect does not rewrite the Billing
projection; verified webhook or reconciliation facts remain authoritative.

## Stripe and HTTP boundaries

The pinned `stripe-go/v84` adapter uses `POST /v1/subscriptions/{id}` with
`cancel_at_period_end=true` for the ordinary effect. It requires the returned
object to confirm `cancel_at_period_end`, `canceled_at`, and `cancel_at` before
emitting a scheduled observation. The account-deletion effect retains
`DELETE /v1/subscriptions/{id}` with no invoice and no proration, and now
requires the provider `ended_at` value as the access end. Both use the caller's
stable idempotency key. Tests use only loopback HTTP stubs with fake keys.

`NewBillingCancellationContractHandler` authenticates the session and
same-origin request before reading JSON, derives owner scope solely from that
session, rejects unknown owner fields, and maps confirmed, retryable, terminal,
and malformed application results to closed responses. It is deliberately not
part of `HandlerOptions`; `NewHandler` continues to return the existing closed
404/503 response for `/api/billing/cancel`.

## Verification and rollback

The focused tests cover effect separation, local scheduled replay, an earlier
provider observation on idempotent replay, cross-effect rejection, owner
mismatch, invalid timestamps, response loss without duplicate effects, Stripe
method/form/response validation, authentication, CSRF, oversized and unknown
input, secret-safe errors, and closed HTTP result mapping. The shared migration
closure gate records F22 as migrated only while these Go evidence paths exist.

Code rollback restores the prior disconnected implementation but cannot undo a
provider effect. If a future approved environment ever connects this path,
rollback must first close the public route and stop new cancellation commands,
then preserve Stripe objects, Billing rows, webhook receipts, idempotency
records, and audit evidence. Never reactivate a subscription, synthesize a
cancellation fact, delete a provider object, or remove stored evidence as part
of code rollback.
