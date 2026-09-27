# Production Launch Gate

Production Launch Gate separates a deployed service from general availability.
It is an application-wide admission boundary, not a frontend feature flag. The
decision remains:

```text
canAccess = publicAccessEnabled OR userAllowed
```

This document describes the Go runtime and the restricted-production work
tracked by Issue #528. General public access remains a separate decision.

## Current trust boundary

The Go origin accepts only an assertion that passes the configured verifier.
The T04/T05 local and test adapter uses a short-lived Ed25519 assertion with an
exact issuer, audience, opaque subject, issued-at, and expiry. It rejects
duplicate headers, non-canonical encoding, unknown or duplicate JSON members,
invalid signatures, clock violations, and assertions lasting more than ten
minutes. The private signing key exists only in the test runner; the server
receives only the public key.

`local-signed` is rejected in production. The explicit production profile uses
Google OIDC discovery and JWKS verification with exact issuer, client
ID/audience/authorized-party, expiry, nonce, redirect URI, and PKCE checks.
Migration 00017 and the PostgreSQL OIDC transaction adapter make state, nonce,
and verifier durable and single-use. Exact `/auth/google/start`,
`/auth/google/callback`, and POST `/auth/logout` routes are mounted only when
that complete production composition is configured. The callback never
provisions an account or promotes the first visitor: an operator must
preprovision the Google issuer/subject and allowlist the stable provider
subject. The former Sites
`oai-authenticated-user-id` header is also rejected, including when a caller
supplies it together with a valid local assertion. A browser-supplied user ID
is not an authentication input.

`/api/launch-status` returns only booleans for the current request. It never
returns a subject or another user's allowlist state. Legacy sync additionally
requires exact equality with the configured legacy owner and same-origin
mutation requests. Protected disconnected endpoints authorize before reading
the request body and still perform no application action.

Per-user responses are `private, no-store` and vary on the signed assertion
header and Cookie. Invalid identity, a missing gate dependency, a malformed
database row, or a database error fails closed. An authenticated but unlisted
user receives `403` from protected APIs and the limited-release UI. No value
from query parameters, JSON fields, browser storage, or public build
configuration is an authorization input.

In production, migration 00018 transactionally binds each session to the exact
verified Google identity. `/api/launch-status`, `/api/session-context`, and
`/api/v2/sync` resolve the opaque secure Cookie, verify the session
Account/Vault/epoch, re-read that binding and allowlist, and fail before reading
a mutation body when admission is absent or revoked. Direct access to the
origin does not bypass this server-side decision.

After a successful server decision, the current browser tab stores only an
admitted boolean in `sessionStorage` so an authorized local-first user can
reload offline. It contains no identity and expires with the tab. Logout purge
clears it in participating tabs before local content deletion completes.
Changing the browser value can expose only the already-downloaded shell; every
network request makes a fresh server-side decision.

## Storage and migration

Go migration `backend/migrations/00001_core.sql` creates PostgreSQL
`launch_config` and `launch_allowed_users` with a default-closed singleton.
Migration `00017_production_control_plane.sql` adds durable OIDC transactions,
shared Vault/DEK nonce reservations, expiring/revocable limited-access grants,
and server-side feature flags. `billing-checkout` is seeded OFF; unknown flags
also evaluate OFF. A flag never replaces the launch gate, Vault ownership, or
entitlement checks. The migration contains no synthetic Stripe subscription.
Migration `00018_production_session_identity.sql` adds only the session-to-
verified-identity binding. The production Checkout endpoint authenticates the
session and gate and evaluates `billing-checkout` on the server; OFF is a
closed route, while ON still reports that Checkout is not connected. Enabling
the flag alone therefore cannot contact Stripe or create a charge.
The migration is applied only by the guarded production form of `notesctl
migrate`; it requires an exact TLS database host/name, explicit forward-only
confirmation, a bounded timeout, the checksum ledger, and session advisory
locking. Request handlers never run DDL. T05 browser tests use profile-disabled
`notesctl prepare-e2e`, which
refuses any URL that is not loopback and the exact `fukamu_notes_go_test`
database, recreates only its test schema, migrates, and seeds one explicit test
subject. Issue #509's separately explicit `local-fixture` profile adds
Account/Vault/session/Billing/Entitlement/DEK and private-directory seed
prerequisites for local/CI composition only. Production rejects that profile,
its values are not production identity or launch evidence, and no business
route or provider is enabled by it.

T17 removed the older TypeScript/D1 runtime, migrations, adapters, and server
tests from the working tree. T14b's immutable source-tree and test-corpus
identifiers remain investigation evidence in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md), not a
deployable fallback. This repository change copied or deleted no external D1
data and performed no Sites operation.

## Deployment inputs

The repository-side composition is not itself a deployed service. An operator
must supply the release's concrete values without committing secret material:

- hosting provider, region, service limits, public URL, TLS and rollback route;
- PostgreSQL provider, region, connectivity, runtime/migration identities,
  backups, retention, capacity and recurring cost;
- the Google OAuth client, exact callback URL, and initial verified provider
  subject mapping;
- a private GCS bucket, full enabled Cloud KMS crypto-key-version resource,
  runtime service identity with object access plus KMS encrypt/decrypt only,
  and a Secret Manager reference for the cursor HMAC key;
- secret references, redacted telemetry, and an isolated restore target;
- exact migration, smoke-test, cutover and rollback commands.

The guarded `notesctl access provision` command keeps general access and
`billing-checkout` closed while transactionally adding one separately verified
Google subject, its Account/Vault/identity, an explicit expiring limited grant,
and an initial versioned wrapped DEK. Replays with the exact same expiry,
limits, and KMS version return the existing Notes identifiers without another
KMS call; differences fail closed. `notesctl access revoke` removes the
allowlist entry and revokes the grant and active sessions without deleting
content or keys. Do not substitute an email address or an internal Notes
account ID for the provider subject.

The read-only `notesctl production status` preflight verifies the exact TLS
database target, migration checksum ledger, default-closed Launch gate,
`billing-checkout=false`, active allowlist/grant correspondence, session
identity bindings, one write key per retained Vault, and encrypted metadata to
key-version references. It reports aggregate counts and fixed blocker codes
only. `restricted-empty` is safe for migration/deployment work but does not
prove that a user can log in; the final release requires `restricted-ready`.

An approved operator runbook must keep general access closed, migrate a new
empty PostgreSQL database, execute those commands from the separately pinned
`notesctl` image, and prove that an unlisted subject and direct-origin spoof are
rejected. Opening general access is a later, separate business and production
decision.

## Cutover and rollback contract

The eventual release unit binds one frontend artifact hash, Go image digest,
database migration version, public configuration, secret versions, and identity
mapping. Cutover changes routing only after that unit passes the approved smoke
plan. `npm run verify:release` provides the provider-independent immutable-image,
filesystem, non-root, exact closed-route, loopback, and two-cycle network-none
graceful-shutdown evidence described in
[`go-release-artifact.md`](go-release-artifact.md); it neither pushes the image
nor authorizes staging or production. There is no long-lived dual write. T17's
repository-retirement evidence and recovery limits are recorded in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md); passing
that gate is not cutover permission. The four executable local/CI profiles and
their exact feature states are recorded in
[`go-runtime-closure.md`](go-runtime-closure.md).

No production resource or route changed in this integration work, so there is
no production rollback action to execute. A future Go release may roll back
only to a reviewed immutable image digest that is compatible with the current
PostgreSQL schema and ciphertext/security state. If an approved first cutover
plan retains the pre-cutover Sites/D1 service as a time-bounded emergency
route, that exact immutable artifact, database, configuration, and identity
entry must be restored together; it cannot be rebuilt from the retired source.
It must be retained and revalidated immediately before the separately approved
cutover, and is a candidate only before any incompatible Go/PostgreSQL durable
write.

After an incompatible Go/PostgreSQL write, Sites/D1 is no longer a rollback
target. Stop writes and select a compatible immutable Go image or reviewed
forward recovery while preserving both datastores, encrypted objects,
key/nonce material, journals, consent/billing/deletion evidence, sessions, and
entitlements. Never point the historical backend at PostgreSQL, point Go at
D1, dual-write, replay external effects, synthesize evidence, restore revoked
sessions, reverse-copy/backfill/replay PostgreSQL/Go writes into D1, resurrect
deleted data, or delete either datastore/evidence as rollback. Issue #514
performs none of these production actions; deployment,
database migration, traffic cutover, and external resources remain explicitly
`not-performed` and approval remains pending.
