# Account-wide session revocation

Issue #169 adds the first external effect used by the account-deletion saga:
revoking every active session owned by the authenticated Account and Personal
Vault. It does not expose an HTTP account-deletion endpoint and does not cancel
billing or delete content.

## Boundary and sequence

`AccountSessionRevocationPort` is the provider-neutral application contract.
The account-deletion service derives its `AccountId` and `VaultId` only from the
persisted, already-authenticated saga operation. Request bodies cannot supply or
replace that scope. The caller also supplies the revocation timestamp; neither
the pure plans nor the adapter reads a clock.

The D1 adapter executes these statements as one D1 batch:

1. confirm that the exact Account/Vault owner pair exists;
2. revoke every session in that scope whose `revoked_at` is still null;
3. confirm that no active session remains in that scope.

The operation includes all session epochs and the initiating session. A second
execution updates zero rows and is successful only after the owner and
zero-remaining checks pass. Another Account's sessions cannot match either
scope predicate.

The stable session schema already supports the `security` revocation reason.
Account deletion uses that existing reason rather than rewriting the sessions
table and its check constraint. A future reason-label migration is not required
for deletion correctness and is outside this Issue.

## Saga result and failures

A confirmed result becomes the `revoke-sessions` success input consumed by the
pure saga transition, which writes the existing minimal step receipt. The
revoked count is operational confirmation only and is not persisted in the
receipt.

- D1 exceptions and an incomplete/invalid result become a retryable failure
  with a non-sensitive fixed code.
- An Account/Vault owner mismatch becomes a terminal failure and cannot advance
  the saga.
- No caught error text, token hash, session ID, cookie, or user content is
  written to a receipt or log.

An adapter failure may occur after an idempotent revocation was applied but its
confirmation was lost. Retrying is safe: already-revoked sessions are never
reactivated, and success is recorded only after the remaining-active check.

## Migration and rollback

No migration is added. The existing session table and account index are used.
Rolling back the code stops new bulk-revocation attempts but must never restore
sessions already revoked. Production D1 operations, live user sessions, main,
and deployment remain separately approved actions and are not part of #169.
