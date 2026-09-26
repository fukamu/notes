# Private encrypted object storage

The Go repository and isolated memory-storage adapter were introduced by
Issue #430. Issue #464 adds the disconnected account-deletion consumer for the
PostgreSQL delete outbox. It verifies the exact owner, deletion operation, and
prior receipt; selects only a bounded due batch; accepts storage `not-found` as
idempotent success; and requires compare-and-swap confirmation plus a zero
post-count. The generic Go outbox drain now also rejects zero-row completion or
reschedule mutations. No production object-storage adapter or credential is
configured.

Issue #117 adds a provider-neutral, Vault-scoped storage boundary for immutable
Envelope Encryption ciphertext. It is not connected to the legacy `/api/sync`
route and does not configure or access a production R2 bucket.

## Write ordering and idempotency

The application service first checks committed metadata by `EncryptedWriteId`.
A completed retry returns that result without calling object storage or KMS. For
a new logical revision, D1 reserves a pending write intent containing a random
256-bit opaque object key before encryption. The ciphertext is written with
put-if-absent semantics and the D1 adapter then commits immutable metadata with
a single Vault-scoped revision CAS.

If the response or D1 commit is lost after object storage succeeds, the pending
intent retains the same object key. A retry reads that immutable object and
retries only the metadata commit. A competing CAS moves its object key to the
delete outbox. D1 or object-store failures never fall back to plaintext.

## Read and tenant boundaries

D1 stores only object type/id, revision, idempotency and opaque object keys,
plaintext/ciphertext byte counts, crypto/DEK versions, and timestamps. It does
not store nonce, sealed payload, card title/body, conflict content, or a raw
DEK. Every primary key, secondary index, CAS, intent, and outbox query is
Vault-prefixed and guarded by the captured Account/Vault/partition route.

The object-storage port is private and already scoped to one Vault by
composition; its operations do not accept AccountId or VaultId. Reads compare
D1 sizes and crypto versions with the stored envelope before AES-GCM verifies
the Vault/object/revision AAD. Swapping ciphertext between objects therefore
fails closed.

## Orphan and delete recovery

An orphan scan compares the scoped private-object listing with committed and
pending D1 keys. It enqueues only unprotected objects older than a caller-set
grace period, avoiding races with an active write. Delete workers process due
outbox entries idempotently and reschedule failures with caller-supplied retry
timing. Deleting production objects, production scheduling, and a real R2
adapter remain separate work requiring their own approval. Account-deletion
ordering continues through its receipt-gated purge service rather than the
general operations runner.

Issue #486 adds the local/test-only `notesctl objects orphan-scan` runner. It
verifies the exact Account/Vault owner before listing storage, accepts an
explicit scan timestamp, grace period, and 1..100 enqueue limit, and reports
`pending` when another bounded pass may remain. The global protected-key query
now includes committed metadata, active intents, and existing delete-outbox
rows across every Vault. The enqueue statement rechecks committed metadata and
active intents, so a concurrent write cannot turn a protected key into a
delete candidate. Repeating the same invocation is safe: existing outbox rows
are not duplicated and subsequent batches progress in stable object-key order.
The runner only enqueues metadata; it never deletes object bytes.

Issue #488 adds the local/test-only `notesctl objects delete-outbox` runner for
the general outbox created by abandoned writes, losing metadata CAS operations,
re-encryption replacement, and orphan collection. It validates one exact
Account/Vault before outbox selection or storage deletion and processes at most
the declared 1..100 due entries. The scoped PostgreSQL adapter also re-verifies
ownership, excludes keys currently referenced by committed metadata or an
active write intent, and keeps protected rows pending for investigation.

Object deletion precedes the outbox CAS because storage and PostgreSQL cannot
share a transaction. `deleted` and `not-found` are therefore both successful:
after a lost confirmation response, retrying the same row safely observes the
missing immutable object and confirms the row. Storage failures increment the
attempt exactly once and set `next_attempt_at` to the explicit attempted time
plus retry delay. Zero-row confirmation/reschedule mutations are classified as
replayed when the row is gone and as contention when a winner changed its
attempt; a loser never overwrites or removes the winner's row.

The runner is restricted to the loopback disposable database and an existing
absolute, symlink-free private directory. Output contains only bounded outcome
counts. Tests use in-memory or temporary directory storage and isolated
PostgreSQL data, including two workers released onto the same row. No production
provider, object, credential, scheduler, deployment, or external resource is
selected or accessed.
