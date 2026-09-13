# Vault-scoped server repository and tenant routing

Issue #115 adds the provider-neutral tenant-routing boundary for the future
authenticated sync service. It is not connected to the legacy `/api/sync`
route and does not store card plaintext or ciphertext.

## Scope-bound access

`D1VaultContentDirectory` accepts a verified `VaultContext` and checks the
Account/Vault pair through the public Identity/Vault control-plane API before
assigning a partition. Opening a repository uses that same pair and returns an
opaque `not-found` result for a missing or mismatched mapping.

An opened `VaultContentRepository` captures AccountId, VaultId, PartitionId,
and routing revision. Its card, mutation-receipt, and conflict methods do not
accept AccountId or VaultId. Every SQL read, list, insert, update, CAS, and
delete binds the captured VaultId and verifies that the captured partition
route is still current. A repository opened before a partition remap therefore
fails closed with `not-applied`; callers must reopen it through the directory.

The new tables use these tenant keys:

- `vault_cards`: primary key `(vault_id, card_id)`;
- `vault_mutation_receipts`: primary key `(vault_id, mutation_id)` and a
  Vault-prefixed card index;
- `vault_conflicts`: primary key `(vault_id, conflict_id)` and a Vault-prefixed
  card index;
- `vault_partition_mappings`: one route per Vault, with an owner index and a
  `(partition_id, vault_id)` operational index.

The same CardId, MutationId, or ConflictId can consequently exist in two
Vaults without collision. Content-table foreign keys remain composite and
Vault-prefixed. Partition assignment is additionally checked against the
Identity/Vault module rather than exposing its tables to this module.

## CAS and remapping

The pure routing plan accepts a remap only when the expected routing revision
matches, the destination changes, and the timestamp does not move backwards.
The D1 update repeats the AccountId, VaultId, and expected revision in its
predicate. A concurrent or repeated remap returns `not-applied` without
revealing another tenant's state.

Card index creation starts at revision 1. Updates require the current revision,
the next consecutive revision, and a non-decreasing timestamp. The adapter
performs the final write with both the card revision and current route in the
SQL predicate, so a race between the pure plan and D1 write cannot cross a
Vault or continue on a stale route.

## Deliberate limits

This migration contains routing and content index metadata only. Encrypted
payload/object storage belongs to #117 after the encryption contract in #116;
incremental cursor and receipt semantics belong to #118; the authenticated v2
endpoint belongs to #121. The legacy v1 schema and local browser runtime remain
unchanged.

Production migration application, partition provisioning, and rebalancing are
not performed here. The checked-in migration targets a new empty production
schema. Before production launch, provider-specific routing and operational
rollback require their separate approved runbook.
