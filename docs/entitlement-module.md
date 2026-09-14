# Entitlement module boundary

Issue #119 introduces the provider-neutral authorization boundary between
Billing facts and feature code. Billing remains the owner of subscription and
payment facts. Entitlement alone turns the public `BillingApi.readSubscription`
result into capabilities and limits. Notes, sync, quota, and UI code must use
`EntitlementPort`; they must not read Billing tables, provider states, or
Entitlement persistence rows.

Authentication establishes `VaultContext` before this module is called. The
module verifies Account/Vault ownership, reads Billing through its public API,
evaluates a pure policy, then commits a tenant-scoped projection. Missing,
malformed, stale, or unavailable data never grants notes access.

## State and online capability policy

The boundary is exclusive: access is allowed while `checkedAt < validUntil` and
is denied at `validUntil`.

| Billing fact                                                | Entitlement state         | Notes read/write/sync    | Recovery, cancel, account deletion, support |
| ----------------------------------------------------------- | ------------------------- | ------------------------ | ------------------------------------------- |
| checkout pending or payment method not ready                | locked                    | deny                     | allow                                       |
| trialing, payment method ready, before the exact 14-day end | trial active              | allow until trial end    | allow                                       |
| trialing at or after trial end without a paid invoice       | locked                    | deny                     | allow                                       |
| active inside a verified paid invoice period                | paid active               | allow until paid-through | allow                                       |
| payment failed or payment action required                   | locked immediately online | deny                     | allow                                       |
| payment method updated after delinquency                    | remains locked            | deny                     | allow                                       |
| a strictly newer verified paid invoice reflected by Billing | paid active               | allow until paid-through | allow                                       |
| cancelled, or at a scheduled cancellation boundary          | locked                    | deny                     | allow                                       |

This module cannot manufacture an active paid period. In particular, redirect
completion, UI state, a client plan, and payment-method updates are not grant
evidence. The trial duration originates in Billing's verified 14-day fact; the
clock alone cannot extend it into day 15.

`readLimits` is the single public limit view for #125. It returns the confirmed
10,000 active cards, 1,000 displayed characters per card, 8 KiB serialized
plaintext per card, and 128 MiB plaintext per Vault only while content access is
active. #125 remains responsible for defining byte/count algorithms and
enforcing each limit at the application boundary.

The count and byte algorithms are now fixed in
[Personal Vault quota policy](quota-policy.md). D1 reservation and Sync v2
enforcement remain separate dependent Issues; this pure policy does not make a
client counter authoritative.

## Offline lease decision boundary

The offline lease duration remains a parent #106 Decision Required. The policy
is therefore a discriminated union:

- `undecided`: lease issuance is denied with `lease-policy-undecided`;
- `configured`: a caller-supplied, validated positive duration is capped by the
  current trial or paid period.

There is no default duration and no production allow-all fallback. A concrete
duration can be supplied only after the product decision; changing that
parameter does not change the state machine. Leases are bound to Account,
Vault, Session, and SessionEpoch. They authorize offline notes read/write only;
sync and recovery actions require an online check.

A fully offline device cannot learn about payment failure immediately. Once an
online check observes a locked Billing state, the projection change and all
active lease revocations are committed in one repository transaction. An
already disconnected device can continue only until its previously issued
lease expires. This is the physical limitation that the outstanding duration
decision must balance.

## Persistence and adapters

Entitlement owns `entitlement_projections` and
`entitlement_offline_leases`. Both include Account/Vault scope and Billing
source version. Projection updates use version/CAS; older Billing versions or
older checks cannot overwrite a newer projection. Lease creation checks the
exact projection and Billing versions so a concurrent locked projection cannot
issue a lease.

The D1 adapter decodes all rows from `unknown`. The fake repository is injected
only by explicit test/local composition and has the same CAS, scope, replay,
and revocation behavior. Neither adapter selects itself from environment
variables. Production composition must explicitly supply D1, Control Plane,
Billing, and an offline lease policy.

The additive migration targets a fresh production schema and is not applied by
this Issue. There is no migration of current Sites data. Before v2/paid gates
are enabled, rollback is a revert of this module and its integration commit;
destructive production migration or deployment requires separate approval.

Main is unchanged, and no production deployment, real charge, Stripe webhook,
or production D1 operation is part of #119.
