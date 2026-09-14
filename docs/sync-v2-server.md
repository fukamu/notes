# Authenticated Sync v2 server composition

Issue #121 connects the versioned Sync v2 protocol to authenticated session
ownership, the Entitlement public capability API, the tenant-scoped D1 journal,
and encrypted object storage. It does not enable production, select an R2 or
KMS provider, or change the browser replica.

## Request boundary and dependency direction

`createSyncV2HttpHandler` performs the HTTP work in this order:

1. decode the injected clock and validate the same-origin session request;
2. derive `VaultContext` from the secure session cookie and server control
   plane, never from request JSON;
3. enforce the existing bounded JSON and Sync v2 wire codecs;
4. authorize `notes-sync` and read Personal Vault limits through the
   Entitlement public API; and
5. invoke the Sync v2 application with the measured request bytes and
   scope-bound quota, journal, and encrypted content repositories.

The handler imports neither Billing nor Stripe state. The composition root is
the only module that constructs concrete D1 and encrypted-object adapters.
Sync orchestration depends on their public ports, while canonical mutation
serialization, cursor windows, conflict planning, route comparison, hydration,
and HTTP result mapping remain typed pure functions.

Expected client failures use generic `no-store` responses: unauthenticated
requests are `401`, CSRF failures are `403`, locked or unavailable entitlement
is `402` or `503`, invalid wire/cursor input is `400`, mutation conflicts are
`409`, and oversized input is `413`. Unexpected dependency failures are `503`.
Logs contain only the error class name, not content, tokens, keys, cursor
claims, tenant identifiers, or billing values.

## Local and production modes

The `FUKAMU_SERVICE_MODE` binding separates the existing development service
from the future paid service:

- an absent binding or `legacy-test` preserves the current local/Sites test
  `/api/sync` behavior, so local editing does not require checkout, Stripe,
  R2, or a production KMS; `/api/v2/sync` is not exposed in this mode;
- explicit `public-paid` disables the unauthenticated v1 handler; and
- an invalid binding fails closed and also disables v1.

The checked-in v2 route deliberately returns unavailable in `public-paid`
until separately approved real R2 and KMS-backed ports are supplied. It never
substitutes test fakes, an allow-all entitlement adapter, plaintext storage, or
legacy unauthenticated sync. The injectable D1 composition is exercised with
local Miniflare and fake external ports only in tests.

## Cursor, idempotency, and encrypted hydration

Cursors are opaque HMAC-SHA-256 tokens bound to Vault, device, page position,
and fixed high watermark. Authentication occurs before parsing claims;
Vault/device mismatch is reported only as invalid input. Continuation pages
therefore cannot cross tenants or silently move their snapshot boundary.

Each decoded mutation is canonically serialized and SHA-256 fingerprinted. A
durable matching receipt is returned before any encrypted content read or
write, making response-loss retries idempotent. Mutation IDs reused with other
content fail closed. New content is written through the envelope-encryption
service before the D1 journal commit. If that commit fails, retrying the same
mutation reuses the immutable encrypted write and completes the journal without
encrypting or uploading it again.

Quota admission surrounds that existing write path without changing the v2
browser wire. Details, failure ordering, and the separately exposed deletion
operation are documented in
[Sync v2 quota enforcement](sync-v2-quota.md).

Journal upserts are hydrated from the exact encrypted object revision named by
the fixed page, rather than from a newer current revision. Tombstones require
no object read. Empty pages and terminal receipt retries perform D1 metadata
work only, so they do not call object storage or KMS-backed encryption.

## Rollback and activation boundary

This change is additive and includes no production migration or data transfer.
Before production activation, provider-specific R2/KMS adapters, secret
provisioning, environment bindings, operational validation, and deployment all
require their owning Issues and explicit approval. Until then, rollback is to
leave `public-paid` unset (or revert the unused v2 route/composition); the
existing local-first v1 client and its offline, conflict, rebase, link, and
display-ID behavior remain unchanged.
