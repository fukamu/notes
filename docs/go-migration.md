# Go backend migration

This document is the repository-owned status and evidence index for parent
Issue #409. It records implementation state; it is not permission to update
`main`, deploy, create production resources, enable paid/public features, or
delete existing resources.

## Baseline and boundaries

- Audit date: 2026-09-25 JST
- Exact latest `origin/main` and migration research baseline:
  `f423da9932163980485ecc5bc2055b7c8c3b3d8b`
- Integration branch: `integration/409-go-backend-migration`
- Open overlapping work: #403 / Draft PR #404. T09 cancellation and the
  corresponding T12 deletion contract remain dependent on its resolution.
- T01 completed in #410 / PR #411 and T02 completed in #412 / PR #413. T03
  branch `work/414-postgres-foundation` starts at integration commit
  `4c400441eec78fbb047bf0ec233f8b536f7078bc`.
- The source worktree contained untracked `docs/concepts/`; migration work uses
  issue-specific worktrees and does not modify those files.

Production hosting, database provider/region, URL, managed access product,
identity mapping, recurring cost, and shared-service impact are not approved.
Provider-independent Go code, standard PostgreSQL migrations, local fixtures,
and isolated tests may proceed. The current recommended production candidate is
Cloud Run plus same-region Cloud SQL for PostgreSQL and a managed access gate
whose signed identity is verified by Go; this remains a candidate, not a
decision.

## Feature migration matrix

State `A` means connected now, `B` means implemented/tested but disconnected,
and `C` means absent or only a fake/provider gap. A disconnected handler is not
the same contract as its closed route.

| ID  | State | Capability                                  | Go evidence                     | Verification | Status                                  |
| --- | ----- | ------------------------------------------- | ------------------------------- | ------------ | --------------------------------------- |
| F01 | A     | page delivery / SSR-RSC removal             | T05                             | V01,V10      | pending                                 |
| F02 | A     | launch gate / private owner                 | T04                             | V02,V03      | pending                                 |
| F03 | A     | legacy sync                                 | T04                             | V01,V04,V10  | contract captured in #410               |
| F04 | B     | session / CSRF                              | T06                             | V02,V03      | contract captured in #410               |
| F05 | B     | Google OIDC                                 | T06                             | V03          | pending                                 |
| F06 | B     | email OTP                                   | T06                             | V03          | pending                                 |
| F07 | B     | identity / vault context                    | T06                             | V03,V04      | pending                                 |
| F08 | B     | signup admission                            | T06,T10                         | V03,V07      | pending                                 |
| F09 | B     | vault content                               | T11                             | V04,V05      | pending                                 |
| F10 | B     | sync v2                                     | T11                             | V01,V04,V05  | contract captured in #410               |
| F11 | B     | envelope encryption                         | T07                             | V06          | format/AAD captured in #410             |
| F12 | B     | KMS / DEK                                   | T07                             | V06,V09      | pending                                 |
| F13 | B     | key rotation                                | T08                             | V04,V06,V08  | pending                                 |
| F14 | B     | immutable encrypted object                  | T08                             | V04,V06,V08  | pending                                 |
| F15 | B/C   | recovery / reencryption; real backup absent | T08,T13                         | V06,V08      | pending                                 |
| F16 | B     | quota                                       | T11                             | V04,V05      | pending                                 |
| F17 | B     | billing projection                          | T09                             | V04,V07      | blocked on #404 where applicable        |
| F18 | B/C   | Stripe core; production route absent        | T09                             | V07,V09      | pending, remains closed                 |
| F19 | B     | entitlement / offline lease                 | T09                             | V05,V07      | pending                                 |
| F20 | B     | legal checkout evidence                     | T10                             | V01,V07      | contract captured in #410               |
| F21 | B     | terms consent                               | T10                             | V01,V07      | contract captured in #410               |
| F22 | B     | normal cancellation                         | T09                             | V07          | blocked on #404                         |
| F23 | B     | account deletion                            | T12                             | V03,V04,V08  | contract captured; #404 overlap pending |
| F24 | B     | privacy request journal                     | T12                             | V01,V03,V08  | contract captured in #410               |
| F25 | A/B   | migrations                                  | T03 and feature PRs             | V04,V11      | core PostgreSQL schema implemented #414 |
| F26 | B/C   | operations / telemetry; vendor absent       | T13                             | V08,V09      | pending                                 |
| F27 | A/B   | frontend wire contracts                     | T01,T05,T14                     | V01,V10      | executable baseline in #410             |
| F28 | C     | scheduler / realtime services               | none unless separately approved | V08          | intentionally not added                 |

## Verification matrix

| ID  | Required evidence                                       | Current evidence                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------- |
| V01 | shared JSON, strict decoding, black-box HTTP            | T01 fixtures / current TS decoder                             |
| V02 | signed identity, gate DB, spoof/direct-origin rejection | pending T04                                                   |
| V03 | session/OIDC/OTP/owner/CSRF failures                    | T01 session/CSRF baseline; full T06 pending                   |
| V04 | empty Postgres, transactions, concurrency, rollback     | T03 empty DB/constraints/rollback; domain concurrency pending |
| V05 | sync/quota paging, retry, conflict, limits              | pending T11                                                   |
| V06 | crypto vectors, tamper/AAD/KMS failures                 | T01 format/AAD baseline; full T07+ pending                    |
| V07 | billing/evidence duplicate/order/failure                | T01 browser decoder baseline; T09 pending                     |
| V08 | resumable jobs/deletion fault injection                 | T12/T13 pending                                               |
| V09 | approved isolated provider environment / redacted logs  | external approval pending                                     |
| V10 | browser UI/offline/SW/deep links                        | T04/T05 pending                                               |
| V11 | clean build/migrate/image and server-runtime removal    | T14/T17 pending                                               |
| V12 | isolated reference/Go performance comparison            | safe runner in #410; measurements pending                     |

## Intentional security differences

- A client-supplied `oai-authenticated-user-id` will not be trusted by the Go
  origin. A signed, fixed-issuer/audience identity plus an owner decision is
  required before legacy content access.
- The legacy shared table will not become multi-user merely because a public
  flag is enabled.
- Unknown JSON fields, unsafe integers, invalid UTF-8 at the HTTP boundary,
  forged ownership fields, and malformed terminal responses remain rejected.
- These protections are recorded as intentional boundary hardening rather than
  accidental wire compatibility changes.

## T02 runtime foundation

Issue #412 adds the provider-independent Go process without changing current
routing. Go 1.27.1 was rechecked against the official release history on
2026-09-25 and is pinned in `backend/go.mod`, Quality, and the container build
stage. T02 uses the standard library only.

The bootstrap requires an explicit environment, listen address, and absolute
static directory. Invalid configuration exits before listening. It serves a
fixed local index and `/healthz`; `/readyz` returns 503 until T03 supplies
database and migration readiness, and `/api/*` remains closed. Request bodies
are bounded before routing. Logs include method, path, status, and duration but
exclude query strings, headers, bodies, and configuration paths; sensitive
structured attributes are redacted.

`npm run go:check` runs format verification, vet, unit/process smoke tests,
the PostgreSQL integration test, the race detector, and command builds. It is part of the existing read-only
`npm run verify` Quality entry point. The Dockerfile separates the Go build
and static-asset stages and produces a non-root scratch image, but no image is
pushed or deployed by Quality.

## T03 PostgreSQL foundation

Issue #414 adds local, provider-independent PostgreSQL persistence without
selecting or creating a managed database. PostgreSQL 18.6 Alpine is pinned by
multi-architecture image digest for the disposable Compose fixture. The Go
module pins pgx/v5 5.11.0 and goose 3.27.3.

`backend/migrations/00001_core.sql` creates the legacy card/sync tables, the
identity/session/personal-vault control plane, the default-closed launch gate,
and the existing application migration ledger. Goose uses
`notes_goose_versions`; immutable source checksums use
`notes_goose_checksums`; the application-owned `schema_migrations` remains a
separate contract. Checksums are staged before applying SQL so an interrupted
run can resume only with the same migration bytes. Request handlers do not
execute DDL.

The integration test starts from an empty schema and proves repeatable
migration, CHECK/FK/unique and partial-index behavior, rollback when an
expected row is not changed, and checksum-drift rejection. Destructive reset
is refused unless the URL uses loopback and the exact
`fukamu_notes_go_test` database name. `notesctl migrate` additionally requires
the explicit `local` or `test` environment to match `NOTES_ENVIRONMENT` and
never prints the database URL.

```bash
docker compose -f deploy/compose.test.yaml up -d postgres
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl migrate --environment=test
npm run go:test:integration
```

The schema and adapter are implemented but not connected to an HTTP feature;
`/readyz` remains closed until T04 composes DB readiness with the private
identity/gate/sync path. No production database, migration, or credential was
created.

## Build, cutover, and rollback status

A local-only Go bootstrap, PostgreSQL schema, and reviewable Dockerfile now
exist; current frontend routing is unchanged. No managed PostgreSQL instance,
pushed image, staging environment, cutover rehearsal, or production operation
exists yet. The eventual release
unit must bind one frontend hash, Go image digest, schema version, public
configuration, secret version references, and identity mapping. Rollback
restores the matching old Sites artifact, configuration, D1, and identity entry
together; it never points the old TypeScript backend at the new PostgreSQL
database or copies writes in both directions.
