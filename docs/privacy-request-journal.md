# Privacy request journal

Issue #235 adds the provider-neutral journal used to receive and track data subject requests. It does not expose an HTTP route or change the Notes UI. The later HTTP Issue derives `AccountId` and `VaultId` from the authenticated server session; callers never choose the journal scope.

## Stored metadata

Each record stores only scoped opaque identifiers, request kind, revision, state timestamps, an opaque verification receipt identifier, a non-sensitive failure code, and a completion outcome. It does not store an email address, identity document, authentication token, exported content, card title/body, or provider response.

The primary key, idempotency index, state index, reads, and compare-and-swap update all begin with `account_id, vault_id`. The same request or submission identifier may therefore exist independently in two Vaults. A repeated submission in one Vault is idempotent only when its request kind matches; reusing it for another kind is a conflict.

## State and effects

Pure transitions enforce this sequence:

```text
verification-pending -> ready -> processing -> completed
                     |                    -> failed -> ready (retryable only)
                     -> rejected
```

`completed` uses `account-deletion-started` only for deletion requests and `fulfilled` for every other request kind. Reaching `ready` requires a decoded UUIDv7 verification receipt supplied by a future verification adapter. Clock reads, UUID generation, D1 access, export/correction execution, and account deletion remain outside the pure core.

## Migration and retention boundary

Migration `0014_privacy_request_journal` creates an empty table and scoped indexes. It does not migrate the current Sites/D1 data and is never run from a request handler.

The table deliberately has no cascading foreign key to `personal_vaults`: a deletion request must remain trackable while the existing account deletion saga removes the Vault. This is not permission to retain the journal indefinitely. The production retention period and final journal purge are still Decision Required and must be implemented as an explicit lifecycle after legal/operational review. Rollback disables later handlers or uses a forward migration; it must not drop accepted request receipts.

No production D1 operation, provider wiring, deployment, or `main` update is part of this Issue.
