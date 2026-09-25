# Account deletion Vault live-data purge

## Go migration status (T12d)

Issue #462 implements the provider-neutral Go purge in
`backend/internal/vaultdata`, its account-deletion effect mapping, and the
PostgreSQL adapter. Migration `00015_account_deletion_write_gate.sql` closes
the in-flight-write race by serializing mutable Vault inserts/updates and
account-deletion start on the exact Personal Vault row. If a write commits
first, the purge sees it; if deletion becomes durable first, the write is
rejected by the database.

The Go adapter uses one serializable transaction to lock the exact owner,
verify the exact running operation and subscription-cancellation receipt,
enqueue every committed or pending encrypted-object key with the stable prior
receipt time, delete metadata only behind a matching Vault-scoped outbox row,
remove scoped sync-v2/quota live rows, and verify zero remaining live rows. It
fails closed on owner mismatch, cross-Vault key collision, malformed inventory,
serialization failure, or a partial delete. Tests cover response-loss replay,
stable outbox time, another owner, write/delete ordering, and injected rollback.

Physical objects, outbox rows, wrapped keys and rotation state, live
control-plane rows, Billing/Entitlement, legal evidence, privacy requests, and
the deletion journal remain for later ordered barriers. The legacy v1 tables
have no safe owner partition and are not deleted here. The effect remains
uncomposed from the closed HTTP runtime, and no real storage/provider or
production data is touched.

The sections below remain the TypeScript/D1 compatibility oracle. PostgreSQL
does not have the D1 partition-route table, so migration 00015 plus the retained
Personal Vault lock provide the equivalent no-recreation barrier.

Issue #171 adds the `delete-vault-data` effect after session revocation and
subscription cancellation. It deletes only the selected Vault's live D1
content and encrypted-object metadata while preserving durable private-object
delete work. It does not call R2 or KMS, remove wrapped DEKs or Account/Vault
control-plane rows, expose HTTP/UI, touch production, or deploy.

## Ordered module boundaries

The account-deletion runner receives the Account/Vault scope from the persisted
saga operation. It imports only two provider-neutral public ports and runs them
in this order:

1. `EncryptedObjectMetadataPurgePort` moves every opaque key referenced by
   committed metadata or a pending write intent into the existing
   `vault_object_delete_outbox`, then deletes those metadata rows.
2. `VaultLiveDataPurgePort` verifies that no encrypted metadata or write intent
   remains, deletes the Account/Vault-owned partition route, and verifies that
   all Vault content and sync rows are absent.

The second port cannot run successfully while object inventory remains. A
missing encrypted-object route is not itself success: the Vault content port
must still confirm that the persisted owner matches and that all live rows are
already absent. Only then does the saga produce the minimal
`delete-vault-data` receipt and advance to `delete-private-objects`.

## Transaction and retry safety

The encrypted-object D1 adapter uses one D1 batch to insert candidate keys and
delete metadata/write intents. Each source row is deleted only when a matching
Vault-scoped outbox row exists. The batch is transactional, so a failure during
metadata deletion also rolls back newly inserted outbox rows. A post-batch
decoded count must confirm zero source rows.

The Vault route deletion uses `NOT EXISTS` guards for both encrypted metadata
tables in the same SQL statement. This closes the gap where an already
authorized in-flight write might appear between the two phases: the route and
its cascading children are deleted only when inventory is empty at deletion
time. Otherwise the result remains retryable and the first phase runs again.

The cancellation receipt completion time is the stable outbox request time
across retries. Existing outbox rows use `ON CONFLICT DO NOTHING`, so a lost
response and duplicate saga attempt neither duplicates work nor moves its
original creation time. If the route deletion completed but its response or
saga receipt was lost, a retry confirms `route-not-found` plus
`already-purged` and can safely advance.

## Deleted and preserved records

Deleting `vault_partition_mappings` relies on the existing foreign-key cascade
to remove the selected Vault's cards, mutation receipts, conflicts, sync state,
display IDs, v2 mutation commits, change journal/tombstones, encrypted object
metadata, and pending encrypted write intents. Every lookup, inventory write,
guard, and verification remains Vault-scoped; another Account with identical
CardId, MutationId, ConflictId, or object key is unaffected.

The following remain intentionally intact for later barriers:

- `vault_object_delete_outbox`, until #172 confirms physical private-object
  deletion;
- `vault_dek_versions`, until #173 handles wrapped-key metadata;
- Accounts, Personal Vaults, identities, and account-deletion progress, until
  finalization in later Issues.

## TypeScript migration and rollback

No schema migration is added. The implementation uses the existing foreign
keys and delete outbox. Rolling back stops new purge attempts but cannot restore
live D1 rows already deleted; durable outbox and saga progress must be retained
for resume. Tests use fresh Miniflare databases and fake data only. Production
D1/R2/KMS/Stripe operations, deployment, and `main` remain separately approved
actions outside #171.
