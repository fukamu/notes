# Account deletion private-object purge

## Go migration status (T12e)

Issue #464 implements the provider-neutral Go purge in
`backend/internal/encryptedobject`, its account-deletion effect mapping, and an
Account/Vault-scoped PostgreSQL outbox directory. It remains disconnected from
the closed account-deletion HTTP runtime and uses only the isolated in-memory
object-storage adapter in tests; no production bucket, credential, object, or
provider call is configured.

The Go boundary is stricter than the TypeScript compatibility oracle: before
exposing any outbox inventory, PostgreSQL verifies the retained owner, the
exact running deletion operation, the `delete-private-objects` current step,
and the exact prior `delete-vault-data` receipt time. Each later inventory and
mutation operation rechecks that authorization. A caller cannot supply or
guess an object key; only opaque keys already durably present in the scoped
outbox are selected.

The service processes a bounded due batch. Storage `deleted` and `not-found`
are both idempotent success. Confirmation and reschedule updates use the prior
attempt count as a compare-and-swap guard: a missing row is a concurrent replay
and a changed row is a conflict. Storage failures increment the attempt and
move `next_attempt_at` by the configured retry delay, while successful rows in
the same batch stay complete. The account-deletion step succeeds only after a
post-attempt scoped count is zero.

Tests cover exact operation/receipt authorization, owner and scope rejection,
bounded batches, not-found replay, partial failure and backoff, storage success
followed by lost PostgreSQL confirmation, CAS conflict, another Vault, and
preservation of wrapped keys, control-plane rows, Billing/legal/privacy data,
and the deletion journal. Existing general outbox completion/reschedule paths
now reject a zero-row CAS instead of silently reporting success.

No schema migration is needed. Rollback stops future attempts and restores a
compatible artifact while retaining every unprocessed outbox row. A physical
object already deleted cannot be restored; its retained row safely retries as
`not-found`. Wrapped-key deletion and Account/identity finalization remain the
next separately reviewed barrier.

## TypeScript compatibility oracle

Issue #172 implements the `delete-private-objects` account-deletion step without
configuring or calling a production R2 bucket. It consumes the durable inventory
created by #171 and leaves wrapped DEKs and Account/Vault control-plane rows for
#173.

## TypeScript boundary and ordering

`VaultPrivateObjectPurgePort` is the only account-deletion dependency. Its
contract contains AccountId/VaultId, an injected attempt time, and a typed
result; it never exposes opaque object keys, ciphertext, provider responses, or
R2 types.

Inside the encrypted-object module:

1. The purge service is bound to one Account/Vault-scoped object-storage port
   at composition time and rejects a command for any other scope before I/O.
2. `D1VaultObjectDeleteOutboxDirectory` verifies the Account/Vault owner against
   the retained `personal_vaults` row. It does not require the partition route
   removed by #171.
3. A bounded, due batch is selected only from that Vault's
   `vault_object_delete_outbox` rows.
4. Each object-storage delete returns `deleted` or idempotent `not-found`.
5. Only then is the exact outbox row removed with its prior attempt count as a
   compare-and-swap guard.
6. A storage failure leaves the row durable with an incremented attempt and
   caller-configured retry time. Successful rows in the same batch remain
   complete.
7. The step reports `confirmed` only when the post-attempt Vault outbox count is
   zero.

An empty outbox is an idempotent `already-empty` confirmation and makes no
object-storage call. If a batch limit or retry time leaves rows pending, the
result is retryable rather than complete.

## TypeScript failure and replay behavior

A timeout, provider 5xx, or thrown storage failure is treated as
`storage-unavailable`; no provider error detail enters the saga receipt. If the
object was deleted but the D1 confirmation failed, the outbox row remains. The
next attempt receives `not-found`, removes the row, and completes safely.
Malformed D1 rows, unavailable inventory, and CAS conflicts fail closed as
retryable typed results. An Account/Vault mismatch is terminal and makes no
storage call.

The outbox is the authoritative deletion inventory for this step. The existing
orphan collector is responsible for discovering scoped objects before they are
queued; neither request data nor guessed keys can be added during account
deletion. A remaining orphan/outbox row therefore blocks the step, while an
untracked key is never deleted opportunistically.

## TypeScript verification and rollback

The fake private-object adapter distinguishes `deleted` from `not-found`,
counts calls, and can inject a failure for a specific key. Integration tests use
separate Vault-scoped fake stores with equal opaque keys, partial batch failure,
retry backoff, D1 confirmation failure, and duplicate/not-found replay. They
also verify that another Vault's outbox, retained owner, and wrapped DEK are
unchanged.

No schema migration is required. Rollback stops the purge worker and preserves
unprocessed outbox rows. Objects already confirmed deleted are not restored;
retries remain safe because `not-found` is success. Production R2 operations,
deployment, and `main` changes require separate approval and are not part of
this Issue.
