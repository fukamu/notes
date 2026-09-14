# Authenticated legal checkout orchestration

Issue #224 connects the contract evidence from #223 to the existing Billing and
Stripe public ports. It adds handler factories and fail-closed route stubs, but
does not compose a production provider, create credentials, send a Stripe
request, charge a card, deploy, or change the normal Notes UI.

## HTTP boundary

The checkout boundary has two authenticated operations intended for the
dedicated page in #225:

- GET `/api/billing/checkout` returns the current server-derived offer and its
  SHA-256 hash with `Cache-Control: no-store`.
- POST `/api/billing/checkout` accepts only a UUIDv7 submission ID, the presented
  offer hash, and discriminated affirmative consent.

Both derive Account and Vault from the Secure session cookie, apply the existing
same-origin CSRF policy, validate the server clock, and reject malformed or
greater-than-2-KiB JSON. The server creates the evidence ID. Account, Vault,
price, trial date, provider reference, and checkout URL are not accepted from
the request body. Errors expose fixed categories and logs never include request,
contract, or provider values.

POST `/api/billing/cancel` accepts only a bounded non-sensitive idempotency key.
It constructs the cancellation command from the authenticated Vault context and
server clock. It intentionally has no Entitlement dependency, so payment-locked
customers retain the cancellation recovery path. Confirmed, retryable, and
terminal results remain distinct while provider references stay server-side.

The checked-in route files return 404 in `legacy-test` and 503 otherwise until a
separately approved production composition supplies the session store, D1
evidence/Billing repositories, approved legal offer, provider transport, clock,
and identifiers. They never select a fake fallback. Local Notes editing and the
current Sites test environment therefore acquire no billing requirement.

## Evidence and retry ordering

The application records or replays immutable evidence before calling the
provider. The evidence UUID is re-decoded as the Billing subscription ID and the
submission UUID as the Checkout-intent/idempotency ID. These are separate brand
types with one stable UUID value per orchestration. A retry that generates a new
candidate evidence ID first reloads the original scoped evidence, then sends the
same provider idempotency key and contract metadata. Provider response loss
cannot create a second Billing aggregate or change the accepted offer.

Missing consent, stale hashes, cross-Vault repository results, and identifier
conflicts stop before provider access. Provider response metadata must match the
Billing subscription, Checkout intent, evidence ID, offer hash, offer version,
and disclosure version. A mismatch fails closed and does not mark Checkout as
opened.

## Stripe final-action mapping

The pure Stripe plan now sends subscription mode, `submit_type=subscribe`, one
recurring item, mandatory payment-method collection, a 14-day provider trial,
and a bounded submit-adjacent Japanese summary. Both Checkout and subscription
metadata carry the evidence correlation values needed for later audit.

The summary states 14 days at zero yen and automatic billing from day 15. An
exact calendar charge date is not fabricated before Stripe creates the
subscription, because `trial_period_days` starts from provider-side subscription
creation. Before production launch, #225 must capture the actual Stripe-hosted
test-mode rendering and obtain qualified Japanese legal review. If that screen
cannot show the required final terms, the final-action design must change rather
than relying on a link or inaccurate date.

Terms-of-service version consent remains #132. This Issue does not enable
Stripe Dashboard ToS consent or claim that its commercial-offer consent is the
same legal act.

## Rollback and verification

There is no new migration beyond #223. Rollback stops new Checkout acceptance
and reverts the handler/provider mapping while keeping the existing cancellation
port available. Stored live evidence is not rewritten; account deletion still
removes it through the #223 cascade. Production changes and real provider
operations require separate approval.

Focused tests cover authentication, CSRF, body scope injection and limits,
consent/stale-offer rejection, response-loss replay, contract metadata mismatch,
secret-safe errors, and cancellation during payment lock. Repository gates are:

```bash
git diff --check
npm run verify
```
