# Account deletion finalization

Issue #173 owns the terminal server-side barrier after private object deletion.
It does not run a production deletion, call a KMS provider, destroy a KEK, or
deploy any runtime.

## Required order

The `finalize-account` saga step accepts only a valid running deletion snapshot
whose four preceding receipts are ordered and complete. Its effects then run in
this order:

1. The encrypted-object module reconfirms that the exact Vault delete outbox is
   empty. A remaining row stops finalization before wrapped key metadata is
   touched.
2. The crypto module deletes only `vault_dek_versions` for the exact retained
   Account/Vault owner and confirms that no wrapped key metadata remains. This
   removes the server-side path to unwrap deleted Vault content; it is not a KMS
   key-destruction API.
3. The control-plane module transactionally deletes scoped sessions,
   identities, the Personal Vault, and the Account, then confirms that no live
   control-plane row remains.
4. The saga repository may persist the `finalize-account` receipt and completed
   state. Account deletion operation/receipt rows are intentionally independent
   from the live Account foreign-key graph so status can be recorded after live
   state is gone.

Scope comes from the validated saga operation. No AccountId, VaultId, identity,
or key reference is accepted from a request body by these ports.

## Failure and replay

- Missing or malformed preceding receipts reject the step without I/O.
- A non-empty delete outbox, a wrapped-key confirmation failure, or a
  control-plane failure returns a non-sensitive retryable result. Later effects
  do not run after an earlier barrier fails.
- Wrapped-key deletion and control-plane deletion are separately idempotent. If
  the control-plane transaction fails, its mutations roll back while already
  deleted wrapped metadata remains absent; retry continues safely.
- If the final response or saga receipt is lost after live state deletion, all
  three barriers recognize the completely absent Account/Vault as an
  already-finalized success. Partial or cross-tenant absence is an owner
  mismatch, not success.
- Triggered D1 failures and duplicate execution are covered by integration
  tests. Results and receipts contain no identity subject, token, object key,
  wrapped DEK, KEK reference, or content.

After success, old issuer/subject and session-token lookups fail closed. A later
login may provision a new Account and Personal Vault under the existing explicit
identity-resolution rules; it cannot recover or automatically relink the deleted
Account/Vault.

## Migration and rollback

No schema migration is required. The existing cascade constraints are used only
inside the control-plane-owned transaction, while explicit scoped deletes make
the order reviewable.

Rollback means stopping the finalization worker/path before another attempt.
Already deleted wrapped-key metadata or live Account rows are not reconstructed
automatically. Production execution, backup expiry (maximum 30 days), provider
key destruction, and any legal retention record remain separately controlled
operations.
