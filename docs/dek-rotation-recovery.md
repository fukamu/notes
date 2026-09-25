# DEK rotation recovery drill and retirement gate

Issue #190 established the TypeScript fixture-only recovery drill and evidence
gate for old Vault DEKs. Go migration Issue #434 ports that contract to the
provider-independent Go application boundary and shares one versioned manifest
fixture between both decoders. Neither implementation connects to a production
backup, object storage, database, or KMS; neither deletes ciphertext, wrapped
metadata, KEKs, or DEKs. A provider adapter and every real operation require
separate review and explicit user approval.

## Fixture drill

The versioned recovery manifest contains only Account/Vault scope, backup ID,
capture/delete timestamps, wrapped-key metadata, the durable rotation state,
the re-encryption checkpoint state, and encrypted-object metadata. Ciphertext
is loaded through a separate provider-neutral port. Manifest and object values
enter as `unknown`; invalid shape, duplicate object identity/key, missing DEK
version, Vault mismatch, or retention beyond 30 days is rejected before use.

Run the fake drill in this order:

1. Pause new rotation/re-encryption work for the fixture scope. Do not pause or
   mutate a production system under this procedure.
2. Supply a completed rotation snapshot, completed re-encryption marker,
   mixed-version keyring, and immutable old/new ciphertext fixture.
3. Decode the manifest and verify that `deleteAfter - capturedAt` is no more
   than 30 days. A pending checkpoint is a blocked result, not evidence.
4. Load every declared ciphertext. Validate recorded byte counts and crypto/DEK
   versions, then authenticate with the exact Vault/object/revision AAD.
5. Discard recovered plaintext immediately. Persist or report only the typed
   receipt: IDs, versions, timestamps, and object count.
6. Resume from the last durable rotation/re-encryption checkpoint only after
   the blocked cause is understood. A missing object/key, malformed value,
   authentication failure, or backup outage never advances a checkpoint.

The drill deliberately covers both source and target DEKs. A successful
receipt says that this fixture was recoverable at `drilledAt`; it does not prove
that a production provider snapshot is complete or restorable.

The Go evidence is in
`backend/internal/encryptedobject/recovery_test.go` and
`backend/internal/encryptedobject/recovery_service_test.go`. The backup adapter
copies bytes on read and replacement and is isolated under
`backend/internal/adapters/recoverybackup`; it is not composed into the server.

## Retirement evidence gate

The pure gate requires all of the following evidence for the exact
Account/Vault and rotation operation:

- rotation is completed, and the evaluation is not before completion;
- active inventory is complete, route-bound, contains no source-version object
  or pending source-version write, and contains no version newer than target;
- backup inventory is complete; every backup that references the source DEK has
  provider-confirmed deletion no later than its maximum 30-day `deleteAfter`;
- a recovery receipt for the same operation covers both source and target DEK
  versions and is neither stale nor from the future.

Missing or inconsistent evidence returns explicit blocker reasons. Even when
all evidence is present, the terminal result is only
`explicit-production-key-destruction-approval-required`. There is no key-delete
command or port behind this result, so a scheduler cannot turn readiness into
automatic destruction.

## Provider decisions required before production work

Before a real adapter or drill is designed, record and obtain approval for:

- KMS provider semantics for disable, scheduled deletion, cancellation,
  multi-region recovery, audit export, and KEK/version availability;
- backup provider snapshot consistency across D1 metadata and private objects,
  inventory pagination, immutable retention, deletion confirmation, restore
  isolation, and proof that residual copies expire within 30 days;
- R2/D1 failure and rate-limit behavior, operational batch size, alarms, and
  who may issue and approve retirement requests.

Never log plaintext, raw/unwrapped keys, ciphertext bodies, OTPs, or secrets.
Receipts and alerts may contain opaque IDs, counts, versions, phase, and error
codes only.

## Pause, rollback, and escalation

On any blocked or unavailable result, stop the drill, retain all wrapped key
versions and current ciphertext metadata, and resume from durable state after
the dependency recovers. Code rollback removes the fixture drill/readiness
tooling only; it must not revert re-encrypted metadata or remove old/new keys.

If a retained backup exceeds its `deleteAfter`, treat it as a retention-policy
incident and keep retirement blocked. If production evidence eventually reaches
the approval-required state, stop and request a separate explicit approval that
identifies the exact Vault, key/version, provider operation, rollback window,
and audit record. This repository change itself grants no such approval.
