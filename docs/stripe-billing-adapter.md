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
same provider references and refuses mismatched internal metadata.

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
