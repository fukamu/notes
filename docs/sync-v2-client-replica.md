# Sync v2 client replica storage

Issue #165 adds the local persistence boundary required by the incremental sync
client. It does not enable the `/api/v2/sync` transport or change the legacy v1
runtime. Those orchestration changes remain in #122.

## Scope and ownership

`SyncV2ReplicaRepository` is scope-bound when it is constructed. The IndexedDB
adapter accepts a `VaultNotesScope` once and does not accept an AccountId or
VaultId in individual reads or writes. Tenant identity is not stored in card
content. Each Vault continues to use its existing, distinct database name.

The pure `planSyncV2ReplicaCommit` function decides how an already decoded
terminal page collection changes cards, pending mutations, conflicts, and the
checkpoint. IndexedDB requests, transactions, upgrades, and stored-record
decoding remain in `lib/storage/indexed-db.ts` and `lib/storage/records.ts`.

## Schema upgrade

The notes database schema version advances from 1 to 2. The upgrade adds one
`sync-v2` object store with key path `key`; the existing `cards`, `mutations`,
`conflicts`, and `meta` stores and records are retained. A missing checkpoint is
the initial `{ cursor: null, highWatermark: 0 }` state. Stored cursors and
sequences are decoded before use.

The database-name namespace remains unchanged so existing per-Vault offline
content is upgraded in place. If the browser aborts the version-change
transaction, IndexedDB retains the previous database version. The open promise
is removed from the connection registry after an error, so a later attempt can
retry normally.

## Atomic terminal commit

Only a `SyncV2CommitPlan` produced after the final valid page reaches this port.
The adapter reads the current replica and applies these effects in one
read-write transaction spanning all four stores:

- acknowledge only a receipt whose mutation ID and card match the sent request;
- never delete a newer pending mutation that replaced the sent mutation;
- rebase a newer or previously unsent edit onto the received server revision;
- apply card and conflict upserts/tombstones in journal order;
- retain a card covered by a pending local edit when a remote tombstone arrives;
- advance the cursor and high-watermark together with those data changes.

A transaction failure leaves the old cards, pending mutations, conflicts, and
checkpoint intact. A plan based on an unrelated checkpoint is rejected. A plan
whose next checkpoint is already stored is reported as already applied without
repeating its writes.

## Logout and rollback

Constructing the scope-bound repository is lazy and does not open or recreate a
deleted Vault database. The existing session/operation epoch fence remains
responsible for preventing a stale caller from invoking storage after logout.
Database deletion, blocked deletion handling, and crash-resumable purge are not
changed.

Before #122 connects this port to the runtime, rollback consists of removing the
unused Sync v2 repository and checkpoint store support while leaving the v1
storage path unchanged. No production data migration or deployment is part of
this Issue.
