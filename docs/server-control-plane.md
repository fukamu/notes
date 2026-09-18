# Identity / Vault control plane and migrations

Issue #114 introduces the provider-neutral ownership boundary for accounts,
identities, personal Vaults, and sessions. It does not connect production
authentication or migrate the current Sites data.

## Data ownership

`server/control-plane/public.ts` is the small API available to later feature
modules. Only the control-plane implementation may mutate `accounts`,
`personal_vaults`, `identities`, or `sessions`. Callers do not import the
Drizzle tables, row codecs, or D1 adapter.

The database enforces one personal Vault per Account, unique identity by
issuer and subject, and a composite Account/Vault foreign key for sessions.
Session lookup accepts only a validated SHA-256 token digest; raw cookie tokens
are not stored by this module. Identity linking and session revocation take a
verified `VaultContext`, so tenant ownership is not accepted from request JSON.

Billing, entitlement, wrapped keys, and deletion saga state remain owned by
their later Issues and have no tables in this migration. Content partitioning
is owned separately by the scope-bound repository documented in
[Vault-scoped server repository and tenant routing](vault-content-repository.md).

## Explicit migration flow

Feature-owned migration definitions are ordered and validated by the pure
planner in `server/migrations/core.ts`. The D1 runner:

1. bootstraps the non-domain `schema_migrations` ledger;
2. decodes all ledger rows from `unknown`;
3. rejects an unknown migration, a non-prefix history, or a checksum mismatch;
4. applies each pending migration and its ledger insert in one D1 batch.

A failed batch leaves neither a ledger entry nor partial feature DDL. Running
the same manifest again is idempotent. The checked-in Drizzle migration and
snapshot are schema-review artifacts; production application requires a
separate explicit approval.

`server/migrations/production.ts` is the composition point that orders the
Identity/Vault migration before feature-owned later migrations. Feature
modules do not import the control-plane ORM tables or mutation adapter.

`/api/sync` no longer creates tables on a request. Its legacy v1 tables are
created only by compatibility-test fixtures. A runtime whose schema was not
explicitly migrated fails closed instead of attempting request-time repair.

## Local verification and rollback

Miniflare tests create a fresh empty database and apply the manifest without
Cloudflare production access. Local legacy mode remains authentication- and
billing-free; these server tables are not opened by the browser-only runtime.

There is no migration for existing Sites/D1 data. Before production launch,
the approved deployment process must apply the forward manifest to a new empty
database. Rollback for this initial schema is to discard and recreate that
empty, non-production database. No destructive rollback or production apply is
performed by this Issue.
