# Go release artifact verification

Issue #492 added the T14 release-artifact gate and T17 now pairs it with the
checked-in legacy-source residual guard. It builds and inspects a
disposable image; it does not push an image, choose a registry or hosting
provider, deploy, migrate a database, publish a route, or authorize a
production operation.

## Required command

Run the focused gate from the repository root with a working Docker daemon:

```sh
npm run verify:release
```

The shared `npm run verify` gate runs it after the TypeScript, Go, PostgreSQL,
and browser checks. The verifier creates a unique local image and container,
binds the container only to a random loopback port, and removes both before it
returns. A failed cleanup is itself a failed verification. The Docker build
may download the digest-pinned Node and Go builder images and npm/Go build
dependencies; it makes no application-provider request.

## Enforced artifact contract

The checked image must satisfy all of these conditions:

- the final Dockerfile stage is `scratch`, and only the statically linked Go
  `/notes` binary and built `/app/static` frontend are copied into it;
- the runtime identity is exactly `65532:65532`, the entrypoint is exactly
  `/notes`, and the baked environment is exactly the reviewed non-secret
  production defaults with no default command;
- OCI source, title, and full Git-revision labels match the inspected build;
- every saved runtime-layer entry is a regular file or directory under
  `/notes` or `/app/static`; links, unsafe paths, Node/npm, `node_modules`, old
  server/database directories, API source, TypeScript, and SQL are rejected;
- the required index, service worker, web manifest, and bundled JavaScript
  exist, and the copied Go binary and complete frontend tree receive SHA-256
  evidence;
- the image starts in production mode with private runtime composition
  disabled, reports process health, reports not-ready rather than inventing a
  database, serves the Notes shell, pricing page, and a deep link, returns 404
  for unknown page/API routes, and leaves reviewed disconnected APIs at 503;
- `SIGTERM` produces a zero exit and the Go server's graceful-shutdown record.

The repository-level `verify:legacy-retirement` gate separately proves that
the old TypeScript API/server/database roots, their configs and scripts, and
their package and lockfile dependencies are absent. TypeScript remains only
for the React/browser, Service Worker, prerender/build tooling, and tests; none
is copied into the final runtime image.

The smoke run has no database URL, identity key, KMS/object credential, Stripe
credential, mail transport, or production endpoint. It therefore cannot read
or mutate application data and cannot publish or charge for a disconnected
feature.

## Local evidence files

A successful run writes ignored, local-only evidence under `dist/release/`:

- `manifest.json` binds the source revision, image ID, migration version,
  runtime identity/entrypoint, binary/frontend hashes and sizes, and smoke
  route results;
- `sbom.spdx.json` is SPDX 2.3 JSON containing the Go modules embedded in the
  binary plus the production npm dependency graph declared by the lockfile.

The npm list is deliberately conservative build-input evidence. The browser
bundle does not retain a trustworthy one-to-one package attribution, and no
Node package is copied into the runtime image. Both files are regenerated on
each run and are not credentials, deployment manifests, or durable production
attestations. A future approved release pipeline must retain the exact
manifest/SBOM beside the exact registry digest and apply its own signed
provenance policy.

Local runs outside CI label the current `HEAD`; they may include uncommitted
working-tree content while development is in progress. The work-branch,
pull-request, and integration CI runs are authoritative because GitHub checks
out the exact clean `GITHUB_SHA` that the verifier embeds.

## Cutover and rollback

A future approved cutover must select one immutable registry digest whose
revision and manifest match the reviewed integration/main commit, bind it to
the separately approved frontend configuration and migration version, and run
provider-specific staging checks before routing traffic. Passing this gate is
necessary evidence, never deployment authority.

Artifact rollback selects a previously reviewed immutable digest only after
confirming that its code understands the current PostgreSQL schema, ciphertext
versions, and monotonic security state. It does not reverse migrations, delete
data, restore sessions or entitlements, retire keys, or switch Go to D1. Stop
and use the separate data-recovery procedure if backward compatibility is not
proven.
