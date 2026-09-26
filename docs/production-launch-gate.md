# Production Launch Gate

Production Launch Gate separates a deployed service from general availability.
It is an application-wide admission boundary, not a frontend feature flag. The
decision remains:

```text
canAccess = publicAccessEnabled OR userAllowed
```

This document describes the Go migration runtime on integration branch
`integration/409-go-backend-migration`. It does not authorize a `main` change,
deployment, identity-provider configuration, database write, or public launch.

## Current trust boundary

The Go origin accepts only an assertion that passes the configured verifier.
The T04/T05 local and test adapter uses a short-lived Ed25519 assertion with an
exact issuer, audience, opaque subject, issued-at, and expiry. It rejects
duplicate headers, non-canonical encoding, unknown or duplicate JSON members,
invalid signatures, clock violations, and assertions lasting more than ten
minutes. The private signing key exists only in the test runner; the server
receives only the public key.

`local-signed` is rejected in production. The former Sites
`oai-authenticated-user-id` header is also rejected, including when a caller
supplies it together with a valid local assertion. A production assertion
format, trusted proxy, issuer/audience, login entry URL, domain, and subject
mapping remain explicit approval items in
[`go-migration-decisions.md`](go-migration-decisions.md).

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

After a successful server decision, the current browser tab stores only an
admitted boolean in `sessionStorage` so an authorized local-first user can
reload offline. It contains no identity and expires with the tab. Logout purge
clears it in participating tabs before local content deletion completes.
Changing the browser value can expose only the already-downloaded shell; every
network request makes a fresh server-side decision.

## Storage and migration

Go migration `backend/migrations/00001_core.sql` creates PostgreSQL
`launch_config` and `launch_allowed_users` with a default-closed singleton.
The migration is applied only by `notesctl migrate`; request handlers never run
DDL. T05 browser tests use profile-disabled `notesctl prepare-e2e`, which
refuses any URL that is not loopback and the exact `fukamu_notes_go_test`
database, recreates only its test schema, migrates, and seeds one explicit test
subject. Issue #509's separately explicit `local-fixture` profile adds
Account/Vault/session/Billing/Entitlement/DEK and private-directory seed
prerequisites for local/CI composition only. Production rejects that profile,
its values are not production identity or launch evidence, and no business
route or provider is enabled by it.

The older TypeScript/D1 migration and adapters remain as compatibility
reference and test inputs until the reviewed T17 removal. T14b fixes their
source trees and test corpus in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md). They are not
the Go runtime's identity source, and no current D1 data has been copied or
deleted.

## Operations requiring separate approval

Before a production rehearsal, reviewers must approve all of the following:

- hosting provider, region, service limits, public URL, TLS and rollback route;
- PostgreSQL provider, region, connectivity, runtime/migration identities,
  backups, retention, capacity and recurring cost;
- the production signed-identity provider, trusted ingress, issuer/audience,
  opaque owner mapping, sign-in URL and revocation behavior;
- secrets and key references, redacted telemetry, and an isolated rehearsal
  environment;
- exact migration, smoke-test, cutover and rollback commands.

An approved operator runbook must keep general access closed, migrate a new
empty PostgreSQL database, add only a separately verified owner subject, and
prove that an unlisted subject and direct-origin spoof are rejected. Opening
general access is a later, separate business and production decision. Do not
substitute an email address or an internal Notes account ID for a provider
subject.

## Cutover and rollback contract

The eventual release unit binds one frontend artifact hash, Go image digest,
database migration version, public configuration, secret versions, and identity
mapping. Cutover changes routing only after that unit passes the approved smoke
plan. `npm run verify:release` provides the provider-independent image,
filesystem, non-root, closed-route, and graceful-shutdown evidence described in
[`go-release-artifact.md`](go-release-artifact.md); it neither pushes the image
nor authorizes staging or production. There is no long-lived dual write.
The TypeScript reference, removal preconditions, and recovery limits are
recorded in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md); passing
that gate is also not cutover permission.

Rollback restores the matching old Sites artifact, D1 database, configuration,
and identity entry together. It must never point the old TypeScript backend at
PostgreSQL, point Go at the existing D1 database, or infer permission to remove
either datastore. The current integration work has no production rollback
action because no production resource or route has changed. A future image
rollback may use only a reviewed immutable digest that is compatible with the
current schema and ciphertext/security state.
