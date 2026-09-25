# Account deletion saga foundation

## Go migration status (T12b)

Issue #458 ports the provider-neutral saga to
`backend/internal/accountdeletion` and PostgreSQL migration
`00014_account_deletion_saga.sql`. The fixed step order, typed states, bounded
leases and retries, prefix receipts, and compare-and-swap transitions are now
covered by Go unit and PostgreSQL integration tests. The shared account
lifecycle fixture is decoded by TypeScript and Go so public states cannot drift.

`account_deletion_operations` intentionally has no live Account/Vault foreign
key; a continuation and minimal journal must survive finalization long enough
to report the terminal result. An insert trigger nevertheless requires the
exact current Personal Vault owner for every new operation. Receipts and
continuations remain operation-owned and cascade only with that journal.
PostgreSQL tests cover owner rejection, cross-owner operation-ID collision,
sequence and revision races, exact replay, atomic success receipts, malformed
stored rows, and journal access after live Account/Vault removal.

The Go application exposes one explicit port for each effect: session
revocation, immediate subscription cancellation, Vault live-data purge,
private-object purge, and account finalization. A continuation sequence is
consumed before a step is claimed; only a newly applied claim can dispatch an
effect. Provider errors become the non-sensitive `effect-unavailable` code.
Operation ID plus step is the stable effect identity; adapters must make that
identity idempotent across timeout and lease recovery.

Issue #460 implements the PostgreSQL session-revocation adapter, the Go Billing
immediate-cancellation service, and the pinned Stripe cancellation method under
local HTTP-stub tests. They remain absent from runtime and HTTP composition.
Issue #462 implements the PostgreSQL Vault live-data purge and the database
write gate that prevents post-start Vault data recreation. Issue #464 implements
the bounded PostgreSQL-outbox/private-object purge with isolated in-memory
storage tests. Issue #466 implements account finalization with an explicit
fail-closed legal-evidence policy and a PostgreSQL gate that prevents new legal
evidence after deletion starts. The delete-live policy branch is a tested local
candidate, not an approved selection, and the effect remains outside runtime
composition. Issue #468 connects a verified privacy deletion request only to
the durable saga start. Its scoped deterministic identity makes a lost response
replay one operation without executing any step, and `account-deletion-started`
does not mean deletion completed. No provider, production migration, data
deletion, cancellation, deployment, or public route is enabled by #458, #460,
#462, #464, #466, or #468.
The sections below describe the pre-existing TypeScript/D1 implementation that
the Go port preserves as its compatibility oracle.

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

The legacy migration `0009_account_deletion_saga` is additive and part of the explicit
production manifest. This change does not apply it to production. Rolling code
back stops new operations but must preserve operation and receipt rows so an
in-progress deletion can be resumed by the later implementation or runbook.

## Local development

Nothing invokes either repository from the current local/Sites runtime. Existing
local-first notes, offline sync, logout purge, and v1/v2 compatibility remain
unchanged. Tests use Miniflare D1 and pure fixtures only; they perform no real
deletion, billing, email, Cloudflare, or KMS operation.
