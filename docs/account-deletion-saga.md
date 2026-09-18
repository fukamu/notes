# Account deletion saga foundation

Issue #168 introduces only the durable, provider-neutral foundation for account
deletion. It does not expose an HTTP endpoint, revoke a session, cancel a real
subscription, delete content, contact R2 or KMS, or change browser storage.

## Ordered steps

Every operation starts at `revoke-sessions`; callers cannot select or skip a
step.

1. `revoke-sessions`
2. `cancel-subscription`
3. `delete-vault-data`
4. `delete-private-objects`
5. `finalize-account`

The later implementation Issues #169–#175 own those effects. They receive the
stored Account/Vault scope rather than accepting ownership identifiers from an
untrusted request body.

## State and retry contract

The pure core moves an operation through `ready`, `running`, `retry-wait`,
`terminal-failure`, and `completed`. Clock reads, UUID generation, retry delays,
and lease durations are supplied by outer adapters. No default delay or lease
is silently chosen by the core.

A worker claims a `ready` step with a bounded lease. If the process crashes,
another worker can recover the expired lease through the same configured retry
policy. A retryable failure becomes terminal when the injected delay list is
exhausted. Terminal provider failures are never retried automatically.

Successful step transitions and their minimal receipt are committed in one D1
batch. The receipt contains only operation ID, step, and completion time. It
does not contain content, identity claims, session tokens, payment data,
ciphertext, or key material. Replaying an already persisted transition returns
the stored snapshot; a stale revision returns a CAS conflict.

## Persistence and deletion ordering

`account_deletion_operations` allows one durable operation per Account and is
queried with both AccountId and VaultId. Receipts must form an exact prefix of
the fixed step list. Rows are decoded from `unknown`, and an impossible
operation/receipt combination fails closed.

The operation deliberately has no foreign key to the live Account/Vault rows.
That lets the final step remove live control-plane state while retaining a
minimal progress record for retry and the separately governed retention
window. Its receipts do have an internal foreign key to the operation.

Migration `0009_account_deletion_saga` is additive and part of the explicit
production manifest. This change does not apply it to production. Rolling code
back stops new operations but must preserve operation and receipt rows so an
in-progress deletion can be resumed by the later implementation or runbook.

## Local development

Nothing invokes this repository from the current local/Sites runtime. Existing
local-first notes, offline sync, logout purge, and v1/v2 compatibility remain
unchanged. Tests use Miniflare D1 and pure fixtures only; they perform no real
deletion, billing, email, Cloudflare, or KMS operation.
