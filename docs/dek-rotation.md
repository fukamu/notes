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

## Existing ciphertext re-encryption

Issue #189 adds the second stage after promotion. A bounded application batch
selects only metadata older than the promoted write version using a typed
Account/Vault-scoped checkpoint. Every candidate is read and authenticated
with its recorded Vault/object/revision AAD before fresh ciphertext is created
with the current write DEK. Logical object revision, write ID, plaintext size,
crypto format, and creation time remain unchanged.

The replacement uses a fresh immutable object key. D1 then performs an exact
old-metadata CAS and enqueues the old key in the delete outbox in one batch. An
R2/KMS/authentication failure therefore leaves the old metadata authoritative;
a CAS loser leaves only a new orphan covered by the existing grace-period GC.
A repeated exact commit is classified as a replay only when both replacement
metadata and the old-key outbox entry are present.

Page checkpoints never skip a CAS conflict. After reaching the end, the batch
rechecks the complete Vault inventory and restarts from the beginning if an
older row appeared behind the checkpoint. Older pending write intents keep the
batch pending, and a stored object or intent newer than the requested target
fails closed. A Vault with no older object or intent returns before calling
object storage or KMS.

This stage does not delete old objects directly, retire wrapped keys, select a
production R2/KMS provider, schedule a production job, or perform production
operations. The existing outbox worker owns physical deletion. Recovery drill
and the explicit key-retirement approval gate remain Issue #190.

Issue #190 now supplies the fixture-only recovery drill and retirement evidence
gate described in [DEK rotation recovery drill and retirement gate](dek-rotation-recovery.md).
The gate has no delete effect and terminates at a separate explicit-production-
approval-required result even after all evidence passes.

## Explicit Go operations runner

Issue #480 composes the Go state machine and PostgreSQL repository as
`notesctl dek rotate`. One invocation advances only one exact Account/Vault and
operation ID through the durable phases. Stable request, generation, and
completion timestamps make the same command replayable after interruption.
The runner skips generation when wrapped metadata is already durable and skips
all provider work after completion. Unknown or cross-owner scope fails before
KMS access.

The command accepts the existing GCP adapter configuration as a candidate, but
its flags are only accidental-run guards. Issue tests use a fake key port and a
disposable loopback database and make no real KMS request. Production identity,
CryptoKeyVersion, IAM, region/protection level, network, monitoring, cost, and
shared-service impact remain unapproved. See [Go operations runner](go-operations.md#vault-dek-rotation)
for invocation, resume, output-redaction, and rollback rules.
