# Tenant-scoped Sync v2 journal

> Historical migration-source note: the D1 journal below is retained only as a
> compatibility oracle. The executable journal is Go
> `backend/internal/syncv2` with the PostgreSQL adapter and migrations; T17
> removed the TypeScript/D1 source and Sites tooling.

Issue #162 provides the D1 metadata transaction that the authenticated Sync v2
endpoint in #121 will call after encrypted payload storage succeeds. It does not
expose an HTTP route, authorize a session or entitlement, or read and write R2
or KMS.

## Data ownership

The Vault content module owns four additive tables:

- `vault_sync_v2_states` allocates the next official display ID and the next
  change sequence independently for each Vault;
- `vault_card_display_ids` maps a card to its Vault-local official display ID;
- `vault_sync_v2_commits` keeps the SHA-256 mutation fingerprint and durable
  receipt needed to distinguish a response retry from MutationId reuse; and
- `vault_sync_v2_changes` stores ordered card/conflict upsert and tombstone
  descriptors.

The journal contains identifiers, revisions, display IDs, timestamps, and the
mutation fingerprint. Card titles, bodies, links, conflict bodies, plaintext,
ciphertext, wrapped keys, and provider or billing data are not journal fields.
Those content values remain in the encrypted object boundary introduced by
#116 and #117.

## Scope and transaction

`D1SyncV2JournalDirectory.open` first opens the existing
`VaultContentDirectory`. The verified Account/Vault pair and current partition
route are then captured by a repository whose methods do not accept tenant
identifiers. Every state, card, conflict, receipt, and journal query repeats the
captured Vault and route revision in its SQL predicate.

Commit planning is a typed pure function. It checks the current card revision,
conflict ownership, consecutive revision, timeline, display allocation, change
sequence, and an existing mutation receipt before creating an immutable plan.
The D1 adapter then executes one `batch` containing the guarded pending receipt,
index changes, compatibility receipt, ordered journal rows, state advance, and
receipt completion. A database error rolls back the whole batch. A concurrent
state or content change fails the initial compare-and-swap and is returned as a
retryable `cas-conflict` without advancing the sequence.

The fingerprint must be computed from the canonical decoded mutation by #121.
The same MutationId and fingerprint replays the stored receipt without another
change; a different fingerprint is rejected as idempotency-key reuse.

## Paging and no-change requests

The first page captures `next_change_sequence - 1` as its high watermark.
Continuation pages use that fixed value and read `(vault_id, sequence)` in
ascending order with `limit + 1` lookahead. Updates and tombstones therefore
retain their order across page boundaries. A high watermark beyond current
state, or an `afterSequence` beyond the fixed high watermark, is rejected.

`readPage` queries only D1 descriptor metadata. An empty page has no interface
through which it could call encrypted object storage, R2, or KMS. #121 must
hydrate only the non-empty upsert descriptors and must keep this no-change fast
path intact.

## Failure and rollback

The checked-in migration is additive and targets the new, empty production
schema. It was not applied to the historical Sites D1 or any production database by
this Issue. An injected journal-insert failure is tested to leave no card,
receipt, display ID, sequence advance, or change row. Partition remapping makes
an already-open repository fail closed; the caller must reopen it.

Rollback removes or disables the unused #121 composition and reverts this
migration before production application. The existing `/api/sync` v1 tables,
wire format, browser replica, conflict behavior, and route are unchanged.

## Go and PostgreSQL migration status

Issue #452 ports the same disconnected journal contract to
`backend/internal/syncv2` and the PostgreSQL adapter. Migration
`00012_sync_v2_journal` uses the verified `(account_id, vault_id)` owner pair
as its scope. The PostgreSQL deployment is one database rather than a D1
partition directory, so a physical partition route is not copied; the captured
owner scope is repeated in every key and query instead.

One serializable transaction and a Vault-scoped advisory lock atomically apply
the card/conflict index, durable receipt, ordered changes, and allocator state.
Unlike the D1 pending-receipt batch protocol, PostgreSQL needs no externally
visible pending row because transaction rollback removes every partial write.
Retry is limited to serialization and deadlock errors, with at most three
attempts. Exact receipt replay is stable; a different fingerprint and a stale
revision remain distinct failures.

Reads retain the first page's high watermark, return no more than 500 changes,
and reject gaps, malformed tagged rows, future watermarks, or an `after`
position beyond the fixed window. The test suite injects a journal trigger
failure to prove that card and receipt writes roll back, races two updates from
the same predecessor revision, verifies cross-Vault isolation, and exercises a
500-item page followed by a fixed-watermark continuation.

The journal still contains descriptors only. Issue #454 now hydrates upserts
through the existing encrypted-object service and composes authentication,
Entitlement, quota, HMAC cursor authentication, and the strict Go HTTP
contract. The constructor remains deliberately absent from the public Go
handler composition, so `/api/v2/sync` is still closed. Neither Issue applies
migration 00012 outside the disposable test database.

Before persistent use, rollback may recreate only the disposable schema. Once
accepted receipts exist, rollback must stop writes and preserve journal state,
immutable encrypted objects, and quota reservations as one consistency set;
use a compatible artifact or reviewed forward migration rather than dropping
tables, deleting objects, or rewinding sequences.
