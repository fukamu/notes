# Account deletion subscription cancellation

Issue #170 adds the second external effect used by the account-deletion saga:
immediately cancelling the subscription owned by the persisted Account and
Personal Vault. It does not add a Stripe adapter, contact a payment provider,
change entitlement, expose an account-deletion endpoint, or deploy anything.

## Boundary and sequence

`SubscriptionCancellationPort` is the provider-neutral Billing contract used
outside the Billing module. Its command contains only the stored Account/Vault
scope, a non-sensitive idempotency key, and a caller-supplied timestamp. The
provider subscription reference remains in Billing's private record and
provider port; callers cannot supply or observe it.

The account-deletion step is accepted only while the saga is running
`cancel-subscription` and has a valid preceding `revoke-sessions` receipt. The
operation ID becomes the stable cancellation idempotency key. The preceding
receipt's completion time becomes the stable provider request time, so a retry
after a lost response submits the same provider command. The current attempt's
externally supplied execution time is used only for the saga transition.

## Confirmation and failures

The pure Billing core first verifies the Account/Vault owner and the persisted
provider mapping. It confirms only an immediate `cancelled` or
`already-cancelled` observation matching the provider, subscription reference,
idempotency key, and request ordering. A scheduled future cancellation is not
part of the accepted result contract and cannot advance deletion.

- Provider unavailability, malformed output, a lost response, or mismatched
  output is retryable.
- Missing ownership, missing subscription/provider mapping, and provider
  terminal rejection fail closed and are terminal for the saga.
- Only confirmed immediate cancellation produces the existing minimal
  `cancel-subscription` receipt and advances to `delete-vault-data`.

The fake provider models response loss after one cancellation side effect. A
retry with the same command returns `already-cancelled`, proving the saga can
advance without applying cancellation twice.

This direct cancellation port deliberately does not rewrite the local Billing
lifecycle. Verified webhook or reconciliation facts remain authoritative for
Billing and Entitlement state. The deletion receipt proves completion of the
provider effect for the saga; it is not a substitute for ordinary billing
state ingestion.

## Local development and rollback

Local and test compositions must inject the fake provider explicitly. No
environment fallback enables or disables paid service behavior, no secret is
needed, and no real charge or cancellation occurs.

No schema migration is added. Rolling back the code stops new cancellation
attempts, but it cannot and must not restore subscriptions already cancelled by
a completed provider effect. Stripe adapter implementation, real provider
credentials or calls, production webhooks, production data, deployment, and
main remain separately approved actions outside #170.
