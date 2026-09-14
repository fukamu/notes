# Vault DEK rotation lifecycle

Issue #188 adds the first, independently reversible stage of parent #124: a
provider-neutral lifecycle for generating the next Vault DEK and promoting it
as the logical write version. Existing ciphertext re-encryption is owned by
#189, while recovery and key-retirement readiness are owned by #190. This
change does not choose a production KMS, apply a production migration, rotate
a production key, delete a key, or deploy anything.

## Durable phases

One Account/Vault-scoped operation records `generating`, `promoting`, or
`completed` with a CAS revision. Start derives the target as exactly the next
version from the decoded keyring. A duplicate operation ID returns the durable
operation; another ID cannot replace an unfinished rotation.

`generating` is committed before calling `KeyManagementPort.generateDataKey`.
The returned raw DEK handle is destroyed after its wrapped metadata is
validated, including on rejection. The operation then checkpoints only the
wrapped DEK, KEK reference, version, and timestamps. No raw DEK or content is
stored in D1.

Promotion first makes the wrapped target metadata durable as a non-bootstrap
key version. One guarded operation-row update then changes the authoritative
logical write version by moving the operation to `completed`. A lost response
can therefore be retried: an exact target row is reused, a different target row
fails closed, and an already-completed operation is replayed.

The original `is_write_key` row remains the bootstrap pointer for Vaults that
have never rotated. Once an operation exists, its source version remains the
write version while work is pending and its target becomes the write version
only at `completed`. All prior wrapped metadata remains in the keyring, so old
ciphertext remains readable during mixed-version operation.

## Ownership, failure, and rollback

Every D1 load or mutation binds both AccountId and VaultId and checks the
`personal_vaults` owner. D1 rows are decoded from unknown, and inconsistent
operation/keyring state stops the operation. KMS or D1 failure never falls back
to plaintext and never removes the prior version.

The migration is additive. Rollback stops new rotation/resume work while
retaining the operation row and every old/new wrapped version for mixed reads.
Provider-side cleanup after a successful KMS generation whose response was
lost requires the eventual KMS adapter's idempotency and cleanup contract; the
fake adapter is deterministic but is not a production substitute.
