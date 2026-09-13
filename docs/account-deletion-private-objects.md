# Account deletion private-object purge

Issue #172 implements the `delete-private-objects` account-deletion step without
configuring or calling a production R2 bucket. It consumes the durable inventory
created by #171 and leaves wrapped DEKs and Account/Vault control-plane rows for
#173.

## Boundary and ordering

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

## Failure and replay behavior

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

## Verification and rollback

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
