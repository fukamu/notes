# Go release artifact verification

`npm run verify:release` is the T14 production-shaped artifact gate. It builds
and inspects a disposable image, but it does not push an image, choose a
registry or hosting provider, deploy, migrate a database, publish a route, or
authorize a production operation. Issue #514 upgrades its evidence contract to
schema/verifier version 2.

## Required command

Run the focused gate from the repository root with a working Docker daemon:

```sh
npm run verify:release
```

The shared `npm run verify` gate runs it after the TypeScript, Go, PostgreSQL,
and browser checks. Docker may download the digest-pinned build images and
build dependencies; the application runtime receives no provider endpoint or
credential.

## Immutable image identity

The verifier builds with `--iidfile` and validates the resulting content image
ID. Image inspection/save and every container creation use that immutable ID;
after creation, copy/inspect/start/stop/log/remove operations use the complete
returned container ID rather than a mutable name.
The unique human-readable `imageReference` is only a disposable local cleanup
tag for the narrow case where a build succeeds but no valid image ID can be
decoded. It is not a deployment identity. A future approved pipeline must use
an immutable registry digest as the deployable identity.

The checked image must satisfy all of these conditions:

- the final stage is `scratch`, containing only the statically linked Go
  `/notes` binary, built `/app/static` frontend, and the exact system CA bundle
  required for OIDC/GCS/KMS HTTPS;
- runtime identity is exactly `65532:65532`, entrypoint is exactly `/notes`,
  and baked configuration is the reviewed non-secret production-disabled
  default;
- OCI source, title, and full Git revision match the inspected build;
- every saved runtime-layer entry is a regular file or directory under the
  exact `/notes`, `/app/static`, or `/etc/ssl/certs/ca-certificates.crt`
  allowlist; links, unsafe paths, Node/npm, `node_modules`, old server/database/
  API source, TypeScript, and SQL are rejected;
- the required shell, service worker, web manifest, JavaScript, Go binary, and
  complete frontend tree receive size and SHA-256 evidence.

The same Dockerfile also has an explicit `notesctl` target for the migration
and restricted-user operations job. That target is a separate non-root scratch
image containing only `/notesctl` and the CA bundle. It is never copied into
the serving runtime, and the default release-artifact verification continues
to inspect only the final `runtime` target. A release pipeline must pin and
record the operations-image digest separately before executing a reviewed
production command.

The repository-level `verify:legacy-retirement` gate separately prevents the
old TypeScript API/server/database roots, their configs and scripts, and their
package/lockfile dependencies from returning. TypeScript remains only for the
React/browser, Service Worker, prerender/build tooling, and tests; it is absent
from the final request-time runtime.

## Three distinct runtime observations

The verifier performs one loopback HTTP smoke and exactly two independent
network-none lifecycle observations.

1. It copies `/notes` and `/app/static` from a stopped container created from
   the immutable image ID. It executes that binary directly on the host with
   an exact minimal environment and a random loopback port. No ambient proxy,
   cloud, billing, database, identity, or provider variable is inherited.
2. The loopback smoke pins exact status, response bytes, content type, cache,
   `Vary`, and security headers for foundation routes and every one of the 13
   OpenAPI operations. Health and static delivery work; readiness honestly
   reports unavailable. Legacy Sync is 404, protected private-runtime routes
   are `launch-gate-unavailable`, and public cancellation, deletion, and
   privacy routes are `unavailable`. Unknown page/API routes remain exact 404.
3. Two fresh containers made from the same immutable image ID start with
   `--network=none` and no port bindings. Each receives `SIGTERM`, exits zero,
   and supplies its own redacted startup/shutdown log digest. Container IDs and
   log digests must be distinct, preventing copied lifecycle evidence.

The HTTP observation proves the production-disabled route contract. The two
network-none observations prove only repeatable process lifecycle without
external connectivity; they do not pretend that HTTP is reachable with
networking disabled. Every started child/container is drained and all cleanup
targets are attempted even when another cleanup fails.

## Local evidence files

A successful run writes ignored, local-only evidence under `dist/release/`:

- `manifest.json` (schema/verifier v2) binds the source revision, immutable
  image ID, migration version, identity/entrypoint, binary/frontend hashes,
  the exact route matrix, loopback lifecycle, two network-none lifecycles, and
  an explicit production-transition record;
- `sbom.spdx.json` is SPDX 2.3 JSON containing Go modules embedded in the
  binary plus the conservative production npm lockfile input graph.

The manifest transition is exactly `not-performed`: no deployment, database
migration, traffic cutover, or external resource operation occurred and
approval remains pending. Unknown fields, older schema/verifier versions,
missing or duplicate routes, copied lifecycle evidence, or a claimed
production transition fail verification.

These ignored files are development/CI evidence, not credentials, deployment
manifests, signed provenance, or durable production attestations. Local runs
may include uncommitted content; authoritative CI must build the exact clean
reviewed revision. A future approved release pipeline must retain the exact
manifest and SBOM beside the immutable registry digest and signed provenance.

## Cutover and rollback

Passing this gate is necessary release evidence, never deployment authority.
A future approved cutover must identify an immutable registry digest, exact
configuration/secret versions, migration and backup identities, target,
traffic switch, smoke/canary commands, and recovery owner.

Before any incompatible Go/PostgreSQL durable write, a separately retained and
reviewed complete Sites/D1 release unit may remain a rollback candidate only
when its artifact, configuration, secrets, D1 state, and identity mapping are
all known compatible. This repository no longer contains a rebuildable legacy
server artifact. Preserve both the D1 and PostgreSQL datastores and their
evidence while that compatibility boundary is reviewed.

After any incompatible PostgreSQL/Go durable write, Sites/D1 is not a valid
traffic rollback. Stop writes, preserve PostgreSQL, encrypted objects, wrapped
keys/nonces, journals, consent/billing/deletion evidence, sessions, and
entitlements, then use a schema-compatible Go image or reviewed forward data
recovery. Never point either runtime at the other's datastore, dual-write,
replay provider side effects, synthesize evidence, restore revoked sessions,
resurrect deleted content, delete either D1 or PostgreSQL, or delete either
datastore's evidence as rollback.

The provider-neutral decision tree is in
[`production-operations-runbook.md`](production-operations-runbook.md), and the
current executable profile closure is in
[`go-runtime-closure.md`](go-runtime-closure.md).
