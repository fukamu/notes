# Privacy request journal

Issue #235 added the TypeScript/D1 reference journal. Migration Issue #456
ports the same provider-neutral state machine and owner-scoped repository to
Go and PostgreSQL. Neither implementation exposes a route or changes the Notes
UI. The HTTP boundary derives `AccountId` and `VaultId` from the authenticated
server session; callers never choose the journal scope.

## Stored metadata

Each record stores only scoped opaque identifiers, request kind, revision,
state timestamps, an opaque verification receipt identifier, a non-sensitive
failure code, and a completion outcome. It does not store an email address,
identity document, authentication token, exported content, card title/body, or
provider response.

The primary key, idempotency index, state index, reads, and compare-and-swap
update all begin with `account_id, vault_id`. The same request or submission
identifier may therefore exist independently in two Vaults. A repeated
submission in one Vault is idempotent only when its request kind matches;
reusing it for another kind is a conflict.

## State and effects

Pure transitions enforce this sequence:

```text
verification-pending -> ready -> processing -> completed
                     |                    -> failed -> ready (retryable only)
                     -> rejected
```

`completed` uses `account-deletion-started` only for deletion requests and
`fulfilled` for every other request kind. Reaching `ready` requires a decoded
UUIDv7 verification receipt supplied by a future verification adapter. Clock
reads, UUID generation, database access, export/correction execution, and
account deletion remain outside the pure core. Go keeps those effects behind
explicit verification, fulfillment, and deletion-handoff ports.

## Migration and retention boundary

The historical D1 migration is `0014_privacy_request_journal`. Go migration
`00013_privacy_request_journal` creates the corresponding empty PostgreSQL
table, scoped uniqueness, state index, state-shape checks, and an insert-time
owner trigger. It does not copy Sites/D1 data and is never run from a request
handler.

The table deliberately has no foreign key to `personal_vaults`: a deletion
request must remain trackable while the account deletion saga removes the
Vault. The insert trigger still rejects a scope without an exact current
Personal Vault owner. This is not permission to retain the journal
indefinitely. The production retention period and final journal purge remain
Decision Required and must be implemented as an explicit lifecycle after
legal and operational review.

Before any approved persistent apply, rollback is a reviewed code revert plus
disposable-schema recreation. After an accepted request exists, close new
submissions and processing, preserve migration 00013 and every journal row,
restore a compatible artifact or use a reviewed forward migration, and resume
from the stored revision. Never drop accepted receipts or invent a completed
outcome as rollback.

No production D1/PostgreSQL operation, provider wiring, deployment, retention
decision, or `main` update is part of Issue #456.
