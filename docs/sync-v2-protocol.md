# Incremental sync v2 protocol core

Issue #118 defines the provider-neutral wire contract and pure page application
rules for the future authenticated `/api/v2/sync` endpoint. It does not expose a
route, query D1 or object storage, or change the existing `/api/sync` v1 client.

## Wire boundary

Every request and response carries the exact `sync/v2` version. Object decoders
reject unknown fields, so AccountId, VaultId, SessionId, entitlement, and cursor
claims cannot be supplied through the request body. The endpoint in #121 must
derive Vault ownership and access from its authenticated session.

The request contains only a DeviceId, an opaque cursor (or `null` for the first
page), and a bounded set of existing typed mutations. Each response contains a
fixed high watermark, a bounded sequence-ordered change page, mutation receipts,
and a discriminated `more` or `complete` continuation.

The single change stream represents card upserts, card tombstones, conflict
upserts, and conflict tombstones. It therefore preserves update/delete ordering
at page boundaries without treating a partial page as a complete replica.
Existing v1 wire limits remain in force for individual decoded card content;
the tighter 8 KiB plaintext and Vault quotas belong to #120 at the application
boundary.

## Cursor trust boundary

`SyncV2Cursor` proves only that a wire value is a bounded opaque URL-safe token.
It does not claim that the token is authentic. A provider-neutral
`SyncV2CursorAuthenticator` returns either a rejected result or verified
`unknown` claims after checking the signature/MAC. Verified claims are then
decoded once and authorized against the session Vault and request DeviceId.
Claims bind the continuation to a fixed high watermark and reject positions
beyond that snapshot.

The signing implementation and key material are deliberately deferred to the
authenticated server adapter. No production secret or cursor key is introduced
by this Issue.

## Atomic application contract

The page state machine accumulates decoded pages but never mutates its input.
It rejects malformed, reordered, wrong-cursor, high-watermark-changing, and
non-advancing continuation pages with the original state. Identical receipts
across page retries are deduplicated; a changed receipt for the same MutationId
is rejected.

Only a terminal `complete` page returns a `ready-to-commit` plan. The future
local adapter must apply every ordered change, remove mutations identified by
the receipts, and write the next checkpoint in one IndexedDB transaction. If
that transaction or any preceding page fails, it keeps the prior checkpoint and
pending mutations. Retrying a lost terminal response therefore produces the
same plan, and a stored server receipt causes the same MutationId to replay
without applying its mutation twice.

## Rollback and compatibility

Rollback disables or removes the future v2 composition and leaves the existing
v1 endpoint, v1 wire codec, full offline replica, rebase behavior, conflicts,
and IndexedDB schema unchanged. This Issue performs no migration, deployment,
production operation, or main-branch change.
