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
timing. Deleting production objects, account-deletion ordering, and a real R2
adapter remain separate work requiring their own approval and later Issues.
