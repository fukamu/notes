# Account deletion finalization

## Go migration status (T12f)

Issue #466 implements the Go terminal barrier in
`backend/internal/accountdeletion`, the scoped PostgreSQL adapter, and migration
`00016_account_deletion_legal_evidence_gate.sql`. Issue #512 composes it only in
the exact disposable local fixture when
`NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY=delete-live-evidence` is explicit.
It does not run a production deletion, call a KMS provider, destroy a provider
KEK, apply a production migration, or deploy anything.

Legal evidence has no implicit default. An omitted or `undecided` fixture
policy now rejects deletion admission before sealing the Vault fence, creating
an operation, revoking sessions, or changing database/filesystem state. The
earlier design that waited until finalization is deliberately not reproduced:
an undecided legal policy is not authorization to perform the preceding
irreversible effects or create a partial deletion. The long-lived continuation
promotion is only recovery for an explicitly authorized operation; it is not a
policy decision. A deleting or completed fixture also refuses to
restart without the explicit destructive policy. `delete-live-evidence` is
only a disposable local evidence candidate; its presence is not legal or
production approval. Migration 00016 serializes legal
evidence insertion with account-deletion start on the exact Personal Vault row.
Evidence committed first is observed by the policy barrier; evidence attempted
after the deletion journal exists is rejected, so it cannot appear between the
policy check and wrapped-key removal.

The remainder preserves the TypeScript/D1 compatibility contract while noting
the deliberate Go hardening described below.

## Required order

The `finalize-account` saga step accepts only a valid running deletion snapshot
whose four preceding receipts are ordered and complete. Its effects then run in
this order:

1. The PostgreSQL adapter verifies the exact running operation and all four
   preceding receipts in nondecreasing order, then reconfirms that the exact
   Vault delete outbox is empty. Missing, extra, stale, or cross-owner state
   rejects finalization before mutation.
2. The legal-evidence barrier evaluates the explicitly supplied policy. The
   exact connected fixture can reach this step only under
   `delete-live-evidence`; the pure `undecided` finalizer remains fail closed for
   direct contract tests but is never used to admit a live fixture operation.
3. The crypto boundary deletes only `vault_dek_versions` for the exact retained
   Account/Vault owner and confirms that no wrapped key metadata remains. This
   removes the server-side path to unwrap deleted Vault content; it is not a KMS
   key-destruction API. The local deletion barrier first validates every
   object/key/nonce directory and exact database-to-key-file metadata through
   held directory handles. It then removes database metadata, quarantines and
   unlinks the matching key and zero-byte nonce files, and fsyncs the anchored
   directories. A DB-absent/file-present crash window is replayable; a missing
   or mismatched file while DB metadata remains is rejected.
4. One serializable transaction deletes the policy-selected live evidence and
   scoped sessions, identities, verified-email ownership, signup reservation,
   Personal Vault, and Account, then confirms that no live control-plane row
   remains. Personal-Vault cascades remove its cancelled Billing and
   Entitlement projections.
5. The saga repository may persist the `finalize-account` receipt and completed
   state. Account deletion operation/receipt rows are intentionally independent
   from the live Account foreign-key graph so status can be recorded after live
   state is gone.

Scope comes from the validated saga operation. No AccountId, VaultId, identity,
or key reference is accepted from a request body by these ports.

## Failure and replay

- Missing, extra, out-of-order, stale, or malformed preceding receipts reject
  the step without destructive I/O.
- A non-empty delete outbox, unavailable legal decision, wrapped-key confirmation
  failure, or control-plane failure returns a non-sensitive retryable result.
  Later effects do not run after an earlier barrier fails.
- Wrapped-key deletion and control-plane deletion are separately idempotent. If
  the control-plane transaction fails, its evidence and live-state mutations
  roll back while already deleted wrapped metadata remains absent; retry
  continues safely.
- If the final response or saga receipt is lost after live-state deletion, all
  barriers recognize the completely absent Account/Vault as an
  already-finalized success. Partial or cross-tenant absence is an owner
  mismatch, not success.
- The frozen TypeScript compatibility tests established triggered D1 failure
  and duplicate-execution behavior before T17 removed them. Current Go tests
  inject a PostgreSQL trigger failure and cover transaction rollback,
  response-loss replay, policy/write races, missing receipts, and another
  owner. Results and receipts contain no identity subject, token, email, object
  key, wrapped DEK, KEK reference, or content.

After success, old issuer/subject and session-token lookups fail closed. The Go
path also explicitly deletes `signup_admission_reservations`; the TypeScript
finalizer omitted that live uniqueness record, which could prevent later
provisioning with the same verified email or provider subject. This is a
documented privacy and account-recreation correction, not a reason to publish
signup. A later approved login may provision a new Account and Personal Vault
under the existing explicit identity-resolution rules; it cannot recover or
automatically relink the deleted Account/Vault.

## Migration and rollback

Migration 00016 is additive and installs only the legal-evidence write gate.
The existing cascade constraints are used only inside the control-plane-owned
transaction, while explicit scoped deletes make the order reviewable. This
work does not apply that migration outside disposable local tests.

Rollback means stopping the finalization worker/path before another attempt.
Already deleted wrapped-key metadata or live Account rows are not reconstructed
automatically. Once a deletion operation exists, keep migration 00016 and the
journal; dropping the gate could permit new evidence after deletion began.
Restore a compatible artifact or use a reviewed forward migration and resume.
Production execution, backup expiry, provider key destruction, and any
minimised legal-retention record remain separately controlled operations.

For the exact fixture, rollback/restart also preserves residual object
quarantine, key, and nonce files and uses the same explicit delete-live policy.
Completed restart requires the real object/key/nonce directories to be empty.
Never change the policy to `undecided` after admission: startup intentionally
fails rather than hiding the continuation route. Recreating the fixture is only
an explicitly reviewed disposable prepare/reseed action, never a production
recovery procedure.
