# Billing module boundary

Issue #142 introduces the provider-neutral Billing boundary used by later
Entitlement, Stripe, sync, and legal-flow work. It does not enable paid access,
call a payment provider, or deploy a production migration.

## Responsibility and ownership

Billing owns contract and payment facts. It is the only feature allowed to
write these tables:

- `billing_subscriptions`: one aggregate per Account/Personal Vault, its
  provider mapping, CAS version, trial/paid/delinquent/cancellation facts.
- `billing_checkout_intents`: server-created checkout attempts and the opaque
  provider checkout reference attached to them.
- `billing_provider_event_receipts`: verified normalized event IDs and the
  aggregate version to which each event was applied or ignored.
- `billing_reconciliation_checkpoints`: idempotent provider snapshot receipts.

Billing does not decide whether Notes, sync, or another feature may run. The
Entitlement module in #119 will convert the read-only subscription facts into
capabilities and limits. Feature handlers must use that Entitlement API, not a
Billing row, provider status, or payment SDK type.

Authentication and ownership also remain separate. Commands initiated by a
user accept a server-resolved `VaultContext`. The D1 composition checks it
against the Identity/Vault control plane. Verified provider facts do not accept
AccountId or VaultId; they address a server-created BillingSubscriptionId and
must match the persisted provider mapping.

## Public contract and composition

`server/billing/public.ts` is the only contract intended for other feature
modules. It exposes:

- `beginCheckout` and `recordCheckoutOpened` for an authenticated owner;
- `ingestVerifiedProviderFact` for an adapter that already authenticated and
  decoded a provider event;
- `reconcileVerifiedSnapshot` for an authenticated provider API snapshot;
- `readSubscription` for owner-scoped, read-only subscription facts.

The contract contains no Stripe, D1, ORM-row, card, or entitlement type.
`createD1BillingApi` is the explicit D1/control-plane composition point. Core
transitions receive timestamps and identifiers as values and do not read the
clock, environment, database, network, or provider SDK.

`createFakeBillingModule` is a local/test composition. It requires an explicit
owner allowlist and is not selected through an environment fallback. It proves
that core and public-contract tests need no provider credentials or real
charge; it is not a free production mode.

## State and ordering rules

- Checkout starts as `checkout-pending`. This is not a paid or trial fact.
- A verified `trial-started` fact must describe exactly 14 days and records a
  ready payment method.
- `invoice-payment-failed` and `invoice-payment-action-required` produce a
  delinquent fact immediately for later Entitlement enforcement.
- `payment-method-updated` records card readiness but never clears
  delinquency.
- Only a strictly newer `invoice-paid` fact clears a recorded delinquency.
  When paid and delinquency evidence have the same provider timestamp,
  delinquency wins regardless of delivery order.
- Cancellation is terminal in this aggregate. Reopening would require a new,
  explicitly designed subscription flow.
- Provider event IDs and reconciliation snapshot IDs are persisted. Duplicate
  delivery is a replay, while older evidence is recorded and ignored without
  rolling the aggregate back.
- Aggregate updates use an integer version. D1 writes the update and its event
  receipt/checkpoint in one transactional `batch`; a stale version writes
  neither.

Reconciliation may restore an active fact only when the verified snapshot
contains newer paid-invoice evidence. A provider subscription status or client
redirect alone is not sufficient.

## Migration and rollback

The migration is appended to the explicit production manifest and is intended
for a fresh empty production schema. It migrates no current Sites/D1 data and
is not run from a request handler. This Issue only applies it to new Miniflare
databases in tests.

Before a Stripe route or Entitlement consumer exists, rollback is a revert of
Issue #142 and recreation of disposable local/test databases. Applying or
removing production tables, destructive migration, real provider operations,
and deployment require separate approval.

## Verification and remaining work

Focused tests cover the transition table, event replay/order, owner and
provider mapping mismatch, fake/D1 contract behavior, CAS races, transactional
receipt rollback, malformed stored rows, migration checksum, and architecture
negative fixtures. The repository-wide gate remains:

```bash
git diff --check
npm run verify
```

Stripe signature/raw-body decoding and API reconciliation belong to #120.
Capabilities and the approved 24-hour offline entitlement lease belong to #119
and its decision implementation #265.
Price, refund, cancellation deadline, and application confirmation UI remain
in their legal/product Issues and are not decided here.
