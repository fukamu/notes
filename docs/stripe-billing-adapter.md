# Stripe Billing adapter boundary

Issue #120 adds a provider adapter around the public Billing API. It does not
add a production HTTP client, a route, credentials, a webhook registration, or
any live/test charge. The Notes application composition is unchanged, so local
editing does not acquire a billing prerequisite. Tests opt into the fake Stripe
transport and verifier explicitly.

## Responsibility and dependency direction

```text
raw webhook / provider response
  -> Stripe signature + unknown-value decoders
  -> pure Stripe event / reconciliation plan
  -> BillingApi public command
  -> Entitlement public decision on the next read
```

`server/stripe` may import `server/billing/public` but not Billing records,
repositories, D1 schema, or Entitlement internals. It never writes Billing or
Entitlement tables. Billing remains responsible for atomic event receipts,
duplicate detection, ordering, provider mapping, reconciliation checkpoints,
and CAS. Entitlement remains the only module that converts Billing facts into
feature access.

## Checkout contract

The pure Checkout plan pins the Stripe API version to
`2026-02-25.clover` and always sends:

- `mode=subscription`;
- `submit_type=subscribe`;
- one recurring Price and quantity `1`;
- `payment_method_collection=always`;
- `subscription_data[trial_period_days]=14`;
- missing-payment-method end behavior `cancel`;
- a bounded Japanese submit-adjacent summary of the free period, first charge,
  renewal, lock, and cancellation/account-deletion distinction;
- the internal Billing subscription, checkout-intent, contract-evidence,
  offer-hash, offer-version, and disclosure-version identifiers as correlation
  metadata; and
- the checkout intent as the Stripe idempotency key.

The adapter accepts only a response whose Billing and contract metadata all
match the request, plus an HTTPS redirect on `checkout.stripe.com`. A provider
timeout after creation leaves the Billing
checkout pending. Repeating the same internal checkout command uses the same
idempotency key, so a fake-provider contract test covers response loss without
creating a second subscription.

Return URLs must use HTTPS. Explicit loopback HTTP URLs are accepted for local
development; insecure remote HTTP URLs, credentials, and fragments are
rejected.

## Payment-method and entitlement evidence

A Checkout redirect is never payment or entitlement evidence. A completed
subscription Checkout requests a provider snapshot. Trial projection requires
all of the following decoded facts:

- the provider subscription/customer and internal metadata agree;
- the SetupIntent is expanded and has `status=succeeded` and
  `usage=off_session`;
- its customer and PaymentMethod agree with the subscription; and
- the provider trial is exactly 14 days.

`setup_intent.succeeded` records only a payment-method update. Existing Billing
and Entitlement policy deliberately keeps a delinquent subscription locked.
Only a later verified `invoice.paid` fact can restore paid access.

## Webhook verification and mapping

The Web Crypto verifier receives immutable raw bytes, not parsed JSON. It:

1. parses exactly one `t` value and one or more `v1` signatures;
2. computes HMAC-SHA256 over `timestamp + "." + raw body`;
3. asks Web Crypto to compare each signature; and
4. requires the signed timestamp to be within five minutes of the server value.

The five-minute window matches Stripe's documented library default and is not
the test runner's five-second timeout. A zero window is rejected because Stripe
documents that zero disables recency protection. The boundary also rejects
empty or greater-than-256-KiB bodies, invalid UTF-8/JSON, the wrong test/live
mode, and events not using the pinned API version. Raw payloads and secrets are
not returned or persisted.

Supported snapshot events are:

- `checkout.session.completed` (retrieve and reconcile verified state);
- `invoice.paid`;
- `invoice.payment_failed`;
- `invoice.payment_action_required`;
- `setup_intent.succeeded`;
- `customer.subscription.updated` when cancellation is scheduled; and
- `customer.subscription.deleted`.

Other events are acknowledged as unsupported without changing Billing.
Duplicate event IDs and snapshot IDs are handled by Billing's existing atomic
receipts/checkpoints. Stripe delivery order is not trusted; an older payment
fact cannot replace a newer delinquency. Scheduled reconciliation decodes the
same provider references and refuses mismatched internal metadata. The
operator observation time is checkpoint metadata, not payment evidence. A
paid Invoice uses `status_transitions.paid_at`, and failed/action-required
state uses the latest PaymentIntent `created` time. Missing, contradictory,
reversed, or future provider timestamps make the snapshot malformed and grant
nothing.

## Local and production composition

`createFakeStripeTransport` and `createFakeStripeWebhookVerifier` are test-only
ports and have no production consumer. They cover lost responses, malformed
responses, duplicate/reordered delivery, provider snapshots, and no-network
Billing/Entitlement integration. The Web Crypto signature adapter is tested
against official header/payload construction without using a Stripe key.

A future production composition must fail closed when its API key, endpoint
secret, pinned endpoint version, or provider transport is absent. It must not
fall back to these fakes. Creating secrets, making a Stripe test/live request,
registering a webhook, or charging a payment method still requires the explicit
approval recorded in parent #106.

## Stripe primary references checked for #120

- [Create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Receive Stripe events and verify signatures](https://docs.stripe.com/webhooks?lang=node)
- [Subscription webhook events](https://docs.stripe.com/billing/subscriptions/webhooks)
- [SetupIntent object and statuses](https://docs.stripe.com/api/setup_intents)
- [Event object and API version](https://docs.stripe.com/api/events/object)
- [Stripe API versioning](https://docs.stripe.com/api/versioning)

These references were checked on 2026-09-14. Before a real provider transport
or endpoint is enabled, re-check the current GA API version and test the pinned
version in Stripe test mode under a separately approved operation.

## Go T09b implementation

Issue #438 ports this boundary to the disconnected Go backend. The pure
`internal/stripebilling` package owns configuration, Checkout planning,
provider-response validation, raw-body event decoding, reconciliation mapping,
and the application service. `internal/adapters/stripe` is the only package
that imports the official Stripe SDK. It uses `stripe-go/v84` v84.4.1, whose
pinned API version is exactly `2026-02-25.clover`; initialization fails if the
SDK and application versions diverge or if a test/live key prefix disagrees
with the configured mode. The version mismatch escape hatch is not enabled.
SDK telemetry and its raw provider-error logger are disabled at the adapter;
future composition must emit only the repository's bounded, redacted outcome.

The Go HMAC verifier copies verified raw bytes, compares every `v1` signature
in constant time, and applies the same five-minute timestamp and 256-KiB body
limits. The shared `billing/stripe.json` fixture runs through both TypeScript
and Go and fixes every Checkout field plus an exact signed `invoice.paid`
payload. Local HTTP-stub tests inspect the SDK's Stripe-Version,
Authorization, and Idempotency-Key headers, encoded form fields, required
subscription expansions, unexpanded PaymentIntent retrieval, and provider
failure propagation. They use no Stripe credential or network endpoint.

The v84 Invoice model for the pinned Clover API has no legacy `paid` boolean;
the authoritative invoice `status` is used instead. The TypeScript decoder was
updated to accept that pinned wire shape, and the Go pure core derives paid
state from `status == paid` without carrying a redundant provider boolean.
This corrects a stale provider-field assumption instead of preserving it as
compatibility.

Issue #476 also preserves stable provider evidence time during reconciliation.
The SDK adapter maps Invoice `created` and `status_transitions.paid_at`, and
maps the latest PaymentIntent `created` timestamp whether the PaymentIntent was
expanded or fetched separately. TypeScript and Go reject a paid Invoice
without a paid transition, an unpaid Invoice with one, a paid transition before
Invoice creation, and any provider timestamp later than the explicit
observation. Re-running reconciliation later therefore cannot make unchanged
old evidence win ordering. The focused provider tests use a local HTTP stub;
no Stripe endpoint is contacted.

Issue #478 composes that retrieve-and-commit path only into the explicit
`notesctl billing reconcile` operations command. The shared Go
`ReconciliationService` needs only the Billing and provider ports, so the
runner does not invent Checkout URLs, a Price, or a webhook secret. Its
owner-scoped policy derives both provider identifiers from PostgreSQL and
checks an existing reconciliation checkpoint before the SDK can issue a
request. A returned subscription must match the stored customer and
subscription references. There
is no fake-provider fallback in command composition; tests inject their fake
at the command boundary or use local HTTP stubs.

The server remains uncomposed: no HTTP route, endpoint secret, configured API
key, webhook registration, scheduled reconciliation, cancellation mutation,
charge, or entitlement grant is enabled. The explicit command requires an API
key at invocation and was verified without a real provider request. A real
Stripe test-mode call must
first be separately approved and must confirm the Checkout-hosted rendering,
the selected Price, the nested expansion shape, 3DS flows, trial end, invoice
events, and webhook endpoint API version. Production use requires a separate
review of credentials, cost, merchant/PCI evidence, replay/recovery steps, and
the exact resource changes.

Primary references rechecked for #438 on 2026-09-25 were the official
[stripe-go v84.4.1 release](https://github.com/stripe/stripe-go/releases/tag/v84.4.1)
and the current [Invoice object](https://docs.stripe.com/api/invoices/object)
reference. Local module source fixes the exact generated SDK shape used by the
tests; no live provider response was requested.
