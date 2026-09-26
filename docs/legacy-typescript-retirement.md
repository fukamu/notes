# Legacy TypeScript backend retirement evidence

This document is the review and recovery record for T14b under parent Issue
#409. It does not authorize source deletion, a `main` update, production data
access, provider provisioning, deployment, cutover, or destruction of an old
artifact, D1 database, key, secret, Stripe object, or contract record.

## Machine-checked closure

[`contracts/go-migration-closure.json`](../contracts/go-migration-closure.json)
is the canonical F01-F28 and V01-V12 status record. The shared
`npm run verify` gate runs `npm run verify:migration-closure`, which strictly
decodes that file and confirms that all repository evidence paths exist.

The manifest deliberately distinguishes:

- `migrated`: Go implementation and named verification exist;
- `blocked-existing-work`: the capability has a named external work owner and
  cannot be claimed as migrated;
- `intentionally-absent`: the current product does not connect the capability
  and this migration does not add it;
- `complete`, `in-progress`, and `approval-pending` verification states.

Issue #496 ports the ordinary period-end cancellation contract from the exact
reviewed Draft PR #404 head into the disconnected Go Billing, Stripe, and HTTP
boundaries. It does not modify or publish #404 and is not product approval.
F22 now has Go evidence for both ordinary period-end cancellation and the
distinct immediate account-deletion effect, so its legacy reference behavior
may be retired in a reviewed T17 slice while the public route remains closed.
See [`billing-cancellation.md`](billing-cancellation.md).

Issue #502 ports the frozen `server/operations/core.ts` environment/action
matrix and launch evidence decisions into an import-free typed Go policy. Its
tests preserve the complete matrix, ordered blockers, canary and isolated
restore requirements, production explicit-approval boundary, and fail-closed
invalid states. No operation executor or production approval is added. Once
#502 is merged and its checks pass, T17 may retire this TypeScript operations
policy while retaining the Go evidence named under F26/V08.

## Frozen reference

The retirement reference is integration revision
`e8936ab90768774371d84b4808c100d546649943`, derived from main baseline
`f423da9932163980485ecc5bc2055b7c8c3b3d8b`. Its recorded source identities
are:

| Path      | Git tree                                   |
| --------- | ------------------------------------------ |
| `app/api` | `33be5898306605bb5e16287066f11f069054801f` |
| `server`  | `f01b0ad2dab939766e2d86d46effa61becba5d35` |
| `db`      | `049835774238c8b1726f3e85dc992eb26a6cf144` |
| `drizzle` | `25f61bc391b0d90c9e3c145f0ebe20caae693632` |

The legacy-dependent test corpus contains 138 tracked files. The SHA-256 of
the sorted `sha256sum`-shaped file digest list is
`7c28cbe1db282adc1d5349f06ab37964f2b224d4ee3dbc9acad8664e0de50531`.
The verifier fails if either the source trees or corpus drift without reviewed
evidence. Retirement groups also require every legacy source file to have
exactly one feature owner.

For review or incident analysis, restore a read-only source snapshot without
changing a branch:

```sh
git archive e8936ab90768774371d84b4808c100d546649943 \
  app/api server db drizzle > notes-typescript-reference.tar
```

That archive is source evidence only. It is not a deployable rollback unit and
does not contain the old immutable production artifact, configuration, D1
database, identity mapping, secrets, or service-worker state. An operator must
retain those separately under an approved retention policy before any cutover.

## Isolated comparison procedure

The comparison is observational and local-only. Check out exact main baseline
`f423da9932163980485ecc5bc2055b7c8c3b3d8b` in a detached temporary worktree,
install its locked dependencies, and start its existing E2E server. That server
creates a fresh temporary Miniflare D1 directory, applies only checked-in
migrations, inserts the opaque test subject, binds to loopback, and removes its
directory on exit.

After stopping the reference server and deleting its temporary D1 directory,
start the Go implementation from the T14b worktree against the disposable
Compose PostgreSQL fixture. `notesctl prepare-e2e` accepts only the exact
loopback `fukamu_notes_go_test` database. With the default `disabled`
application profile it retains the original compatibility behavior: recreate
that schema, apply the embedded migrations, and insert the same opaque test
subject. Give Go only an ephemeral public verification key; keep the private
test key in the local test process. Sequential use of the loopback port
prevents either process from reaching the other implementation's store.

Issue #509 adds a separate explicit `local-fixture` preparation profile for
later full-Go route composition. It reuses the exact private-runtime database
and origin and, behind the same disposable-database guard, seeds a typed
Account/Vault, hash-only session, local Billing/Entitlement state, wrapped DEK
metadata, and owner-only filesystem roots. Its private key file is generated
or reused without printing key material. Exact-state and foreign-scope checks
fail closed. No business route or external provider is connected by that
foundation, so it is not used to upgrade this legacy-sync comparison into a
full-feature equivalence or V11/server-removal claim.

Then run the same checked-in sync request against each implementation:

```sh
MIGRATION_BENCHMARK_REFERENCE_SUBJECT=fukamu-notes-e2e-user \
npm run benchmark:migration -- \
  --target=reference --base-url=http://127.0.0.1:3100/ \
  --store-id=d1-<unique> --warmup=10 --samples=30

MIGRATION_BENCHMARK_GO_ASSERTION=<ephemeral-signed-assertion> \
npm run benchmark:migration -- \
  --target=go --base-url=http://localhost:3100/ \
  --store-id=postgres-<unique> --warmup=10 --samples=30
```

The runner refuses non-loopback, non-root, credential-bearing URLs; requires
at least one warm-up and five measured requests; uses `redirect: manual`;
validates the legacy sync response arrays; and never prints the header value.
The fixture first creates the same two baseline cards over the public sync
contract, then applies the captured update during warm-up, so measured samples
are the same idempotent mutation replay on each target. D1 and PostgreSQL are
independent target-owned stores, and the fixture invokes no email, identity,
KMS, object-storage, Stripe, billing, deletion, or other external provider.

## Recorded observation

On 2026-09-26 JST, the exact main reference
`f423da9932163980485ecc5bc2055b7c8c3b3d8b` and the Go integration base
`e8936ab90768774371d84b4808c100d546649943` plus the Issue #494 typed runner
completed with zero errors. Both used two setup requests, ten warm-ups, and 30
measured idempotent mutation replays. Identity values were redacted.

| Target                  | Isolated store label        |       p50 |       p95 |       min |       max | errors |
| ----------------------- | --------------------------- | --------: | --------: | --------: | --------: | -----: |
| TypeScript/Miniflare D1 | `d1-f423da9-20260926b`      | 18.330 ms | 19.612 ms | 16.289 ms | 20.646 ms |      0 |
| Go/PostgreSQL           | `postgres-e8936ab-20260926` |  1.455 ms |  2.090 ms |  1.132 ms |  2.175 ms |      0 |

The host was Linux x86_64 (`7.0.0-31-generic`) with Node 24.21.0 and Go
1.27.0. The TypeScript server used an automatically deleted Miniflare D1
directory. The Go preparation command recreated only the allowlisted disposable
PostgreSQL test schema; the Go process stopped after the measurement. No
external-provider request occurred. These figures compare one fixture on one
local host only; they are not a production capacity claim or release threshold.

## T17 removal conditions

Legacy backend removal is permitted only in reviewed T17 Issue/PR slices that:

1. retain the TypeScript/React frontend, browser runtime, service worker, and
   public page output required by the Go-served artifact;
2. change the closure manifest and tests in the same PR, with no unrecorded
   feature, source, or legacy-dependent test silently discarded;
3. retain Issue #496's F22 period-end/immediate separation and focused Go
   evidence when deleting the TypeScript reference behavior;
4. remove request-time and operational TypeScript/JavaScript backend execution,
   obsolete D1/Workers/vinext configuration and dependencies, while keeping
   only frontend/build tooling that the final static artifact requires;
5. pass focused compatibility tests, `git diff --check`, and the full
   `npm run verify` gate before and after integration.

Do not delete test coverage merely because its old implementation was removed.
Move still-applicable behavior to Go tests or frontend-only tests first. A
capability that is truly absent must remain explicit in the manifest.

## Cutover and recovery limits

Source retirement and implementation completion are not production migration.
Before an approved cutover, reviewers still need the immutable old and new
artifacts, exact configuration and secret versions, D1 and PostgreSQL backup
identities, schema/ciphertext compatibility, identity mapping, smoke commands,
traffic switch, and recovery owner. No long-lived dual write is planned.

If the Go release fails before traffic changes, stop and keep the old service
unchanged. After traffic changes but before any incompatible durable write, a
reviewed rollback may restore the complete old release unit. Once PostgreSQL
contains state that the old D1 runtime cannot interpret, stop writes and use an
approved forward recovery or data-reconciliation plan; do not point either
runtime at the other datastore, replay external side effects, synthesize
consent/billing evidence, restore revoked sessions, or delete either datastore.
