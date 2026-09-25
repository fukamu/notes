# Vault quota ledger

Issue #195 adds the provider-neutral reservation contract, fake, and D1 adapter
used to make the Personal Vault limits authoritative under concurrent writes.
Issue #196 connects it to the authenticated Sync v2 application; see
[Sync v2 quota enforcement](sync-v2-quota.md). Neither Issue connects a
production database or deploys the endpoint.

## Durable model

Each `(AccountId, VaultId)` owns one committed usage row and any number of
idempotent reservation rows. Both tables and the reconciliation index include
the Account and Vault scope. The directory opens a ledger only after the
authenticated `VaultContext` matches an existing `personal_vaults` owner. The
caller never supplies a separate owner in a reservation command.

Committed usage is the number of active cards and their current serialized
plaintext bytes. Effective usage is committed usage plus only the positive
parts of pending reservations:

- create reserves one card and all next plaintext bytes;
- an increasing update reserves only `next - current` plaintext bytes;
- a decreasing update and a delete reserve zero additional capacity;
- commit applies the full signed delta to committed usage;
- release removes the positive reservation without changing committed usage.

A decrease therefore does not free capacity until its content write has
actually committed. A failed or timed-out delete cannot make a later create
appear to fit while the original content still exists.

## CAS and idempotency

Reservations use a mutation UUID plus an SHA-256 fingerprint. Replaying the
same ID and fingerprint returns the existing record; reusing the ID for a
different fingerprint is rejected. D1 admission checks the committed revision,
committed values, current pending sum, and limit in the same `INSERT SELECT`.
Concurrent attempts cannot both admit the 10,001st card or the byte beyond the
128 MiB limit.

Finalization changes the reservation and usage through one atomic D1 batch.
The batch advances usage only from the expected predecessor revision, updates
the exact scoped pending reservation, and then inserts a transient assertion
row whose named `CHECK` constraint fails unless both transitions match. D1
rolls the entire batch back on that failure, so a zero-row CAS cannot commit
only one side. The assertion row is deleted in the same batch. The adapter
reloads typed rows and retries only this named CAS assertion failure; unrelated
D1 errors still propagate. Exhaustion is a visible `cas-conflict`, never a
false success or a dropped reservation.

## Reconciliation and failure behavior

`reconcileAfter` marks a pending reservation as eligible for investigation; it
is not an expiry that automatically releases quota. Sync v2 retries use a
durable matching journal receipt to finish a pending commit. A future background
reconciler must obtain the same durable content/journal evidence and explicitly
commit or release the reservation. Until that evidence exists, abandoned
reservations remain charged, which fails closed.

D1 errors and malformed rows propagate as failures. No in-memory or plaintext
fallback is used. The fake implements the same explicit-finalization rule for
local development and tests, without contacting billing, KMS, R2, or any
production service.

## Migration and rollback

Migration `0012_vault_quota_ledger` is additive and intended for the new empty
production schema. Sites migration `0013_vault_quota_finalize_assertions`
adds the transient assertion table separately, allowing a test Sites database
that already applied the quota tables to resume without a reset. No request
handler runs DDL. This issue does not backfill current Sites/D1 data or derive
counters from production content. After consumer integration, rollback must
disable new online mutations before changing ledger state and must preserve
reservations for reconciliation.

Main is unchanged and production is not deployed.

## Go and PostgreSQL migration status

Issue #450 ports this policy and ledger contract to `backend/internal/quota`
and the PostgreSQL adapter. Migration `00011_vault_quota_ledger` keeps the same
owner scope and durable fields. PostgreSQL finalization uses a serializable
transaction with exact one-row checks for both usage and reservation updates;
the D1 finalization assertion table is retained as an empty schema-parity table
but is not part of the PostgreSQL atomicity mechanism.

Admission and finalization lock the Vault usage row, retry only serialization
failures and deadlocks a bounded number of times, and return an explicit
`cas-conflict` on exhaustion. Reconciliation candidate reads remain bounded to
100, owner scoped, and ordered by `reconcile_after` then reservation ID. No
candidate read changes state or treats age as proof that capacity can be
released.

The Go journal/content index is now available as a disconnected boundary from
Issue #452. The ledger remains disconnected until T11c composes quota,
encrypted objects, journal evidence, cursor authentication, and Sync v2 HTTP.
No production migration, backfill, route, provider, automatic reconciler, or
deployment is authorized by #450 or #452.
