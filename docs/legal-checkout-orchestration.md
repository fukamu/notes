# Authenticated legal checkout orchestration

> Historical migration-source note: the TypeScript route/D1 composition
> described below was removed by T17. The current executable closed boundary is
> `backend/internal/httpapi/legal.go`, with Go legal/billing services and
> PostgreSQL persistence. No Sites route or D1 adapter remains in the source
> tree.

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

The Go route returns the disabled-profile compatibility 404 and otherwise
fails closed until an explicit runtime supplies the session store, PostgreSQL
evidence/Billing repositories, legal offer, provider transport, clock, and
identifiers. Issue #510 supplies those ports only in the guarded local-fixture
profile. Its deterministic provider validates the exact seeded rows and
returns a URL-free `local-confirmed` result without a network request, charge,
provider reference, or Billing mutation. Production never selects this fake.
Removing the historical Sites/D1 source does not activate production Checkout
or impose a billing requirement on local Notes editing.

## Evidence and retry ordering

The application records or replays immutable evidence before calling the
provider. The evidence UUID is re-decoded as the Billing subscription ID and the
submission UUID as the Checkout-intent/idempotency ID. These are separate brand
types with one stable UUID value per orchestration. A retry that generates a new
candidate evidence ID first reloads the original scoped evidence, then sends the
same provider idempotency key and contract metadata. Provider response loss
cannot create a second Billing aggregate or change the accepted offer.

Go Issue #444 additionally derives the retry's Billing `createdAt` from the
first immutable evidence rather than a later request clock. This makes the full
Billing command stable after provider response loss. The disconnected
TypeScript path passed the current handler clock and could therefore conflict
with its existing checkout intent if a retry occurred later; that edge case is
not preserved as compatibility behavior.

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

The removed TypeScript terms verifier indexed evidence by the checkout submission ID,
but the terms-consent and checkout clients generate separate identifiers. Go
Issue #446 deliberately does not reproduce that unreachable composition. It
verifies the latest immutable evidence in the resolved Account/Vault scope
against the authoritative current terms. Missing or reconsent-required evidence
stops before commercial evidence and provider access; an explicitly reviewed
notice-only change is non-blocking. The commercial submission ID remains solely
the checkout/provider idempotency key, and the two legal acts remain separate.

Issue #446 also ports the authenticated GET/POST wire contracts to Go. The
handler factories require a complete, separately supplied `LegalRuntime`, use
Cookie session ownership, same-origin CSRF, strict 2-KiB JSON, server-generated
IDs and clocks, and fixed no-store errors. Issue #510 carries the runtime
through `ServerOptions` only for `local-fixture`; the production command still
supplies no legal runtime, so the existing 404/503 closure remains there and no
provider is called.

## Rollback and verification

The removed TypeScript implementation had no migration beyond #223. Go Issue #444 adds
PostgreSQL migration 00010 and keeps it disconnected. Rollback stops new
Checkout acceptance and reverts handler/provider composition while keeping the
existing cancellation port available. Once evidence exists, migration 00010 and
stored rows are preserved and a compatible artifact or reviewed forward
migration is used. T12 must explicitly execute the approved deletion/retention
workflow; the Go foreign key does not silently cascade. Production changes and
real provider operations require separate approval.

Focused Go tests cover authentication, CSRF, body scope injection and limits,
consent/stale-offer rejection, response-loss replay, contract metadata mismatch,
secret-safe errors, and cancellation during payment lock. Retained TypeScript
tests cover only browser disclosure and wire decoding; the former server tests
are frozen ledger evidence. Repository gates are:

```bash
git diff --check
npm run verify
```
