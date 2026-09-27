# Go whole-runtime closure

Issues #514 and #525 record executable whole-runtime and local V12 performance
evidence for the Go migration. They do not perform production deployment,
database migration, traffic cutover, external-resource creation, or a paid
operation. The machine-readable source of truth is
[`contracts/go-migration-closure.json`](../contracts/go-migration-closure.json)
schema version 3.

## T00-T17 status

“Complete (approved scope)” means the provider-independent implementation and
its deliberately local or disconnected composition are complete; it does not
mean a closed production provider or route is enabled.

| Task | Status                                        | Exact boundary                                                                                                                                                                          |
| ---- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T00  | complete (decision register; choices pending) | Baseline, overlapping work, profile boundaries, and still-unapproved production choices are recorded.                                                                                   |
| T01  | complete (approved local scope)               | Contracts, fixtures, and repeated 100/1,000/10,000-card reference/Go plus separate Sync v2 local performance evidence are complete; production-shaped capacity evidence is not claimed. |
| T02  | complete                                      | Go startup, strict configuration, shared checks, health, shutdown, and the Node-free runtime build are executable.                                                                      |
| T03  | complete (approved scope)                     | Guarded local PostgreSQL migrations, empty-database initialization, and exact fixture preparation are executable; no managed database was selected or changed.                          |
| T04  | complete (approved scope)                     | Signed private identity, owner gate, and legacy Sync run end-to-end in the private local profile.                                                                                       |
| T05  | complete                                      | Static frontend/SW delivery and deep links run from the Go process without a request-time TypeScript server.                                                                            |
| T06  | complete (approved scope)                     | Session, OIDC, OTP, and signup logic are in Go; only the exact local fixture session is composed, while public/production identity routes remain closed.                                |
| T07  | complete (approved scope)                     | Envelope/keyring/KMS boundaries are in Go and the local AES path is connected; real production key provider selection and exercise remain approval-pending.                             |
| T08  | complete (approved scope)                     | Immutable-object, rotation, recovery, and guarded runner behavior are implemented; no external object or backup resource is selected.                                                   |
| T09  | complete (approved scope)                     | Billing, Stripe, entitlement, cancellation, and lease boundaries are implemented; only no-network local evidence is composed and paid/provider effects remain closed.                   |
| T10  | complete (approved scope)                     | Terms and URL-free checkout evidence are connected only in the exact local fixture; no charge or public signup is enabled.                                                              |
| T11  | complete (approved scope)                     | Owner/session/entitlement/quota/encryption/PostgreSQL Sync v2 is connected in the exact local fixture; production remains closed.                                                       |
| T12  | complete (approved scope)                     | Disposable deletion and Privacy Submit/Status are connected only in their exact fixture profiles; privacy fulfillment and production deletion remain closed.                            |
| T13  | complete (approved scope)                     | Explicit operation cores/commands and structured lifecycle telemetry are present; F26 stays partially connected because delivery, scheduling, and production automation are absent.     |
| T14  | complete (approved local scope)               | Whole-process, release, closure, retirement, and V12 local performance evidence are complete; production transition remains separately approval-blocked.                                |
| T15  | approval-blocked / not-performed              | No approved staging provider/configuration, external rehearsal, backup restore, or production-shaped provider exercise was performed.                                                   |
| T16  | approval-blocked / not-performed              | This work did not change `main`, deploy, migrate production data, or cut over traffic; external state remains unverified and every action requires separate explicit approval.          |
| T17  | complete (source/config retirement only)      | The request-time TypeScript server and dedicated runtime configuration are retired; external Sites/D1 artifacts and data were neither inspected nor changed or deleted.                 |

## Exact runtime profiles

The manifest accepts exactly these four profiles. Every profile contains one
row for each F01-F28 feature, and every row names same-profile executable
evidence. The verifier rejects missing, duplicate, orphaned, cross-profile, or
truth-matrix-drifted rows.

| Profile                              | Connected runtime boundary                                                                                          | Deliberately closed or absent boundary                                                                  | Executable evidence                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `local-private-legacy`               | Go static/foundation and signed owner-scoped legacy Sync on PostgreSQL                                              | local-fixture Sync v2/session/legal/commerce/deletion/privacy business wires; scheduler/realtime        | E01 `TestWholeRuntimeLocalPrivateLegacy`                                            |
| `local-fixture-undecided`            | exact owner-scoped Sync v2/session, encrypted objects, legal, URL-free commerce/cancellation, privacy Submit/Status | legacy Sync; deletion Start; external identity/billing/fulfillment/provider effects; scheduler/realtime | E02 `TestWholeRuntimeLocalFixtureUndecided`                                         |
| `local-fixture-delete-live-evidence` | the same exact fixture plus the destructive deletion saga and test-only privacy deletion handoff                    | production providers and privacy verification/processor; scheduler/realtime                             | E03 `TestWholeRuntimeLocalFixtureDeleteLiveEvidence` and E04 live Chromium deletion |
| `production-disabled`                | health and static frontend only                                                                                     | all business APIs, identity, persistence, providers, deletion/privacy processing; scheduler/realtime    | E05 `verify:release`                                                                |

`connected`, `partially-connected`, `closed`, `not-connected`,
`intentionally-absent`, and `approval-pending` have different meanings. In
particular, a mounted fail-closed route is not a connected business feature,
and implemented-but-uncomposed domain code is not a production capability.
F12 production key management and F18 production billing remain
`approval-pending`; F28 scheduler/realtime remains intentionally absent.
F26 is `partially-connected` in all four profiles because structured lifecycle
telemetry is executable, while provider delivery, scheduling, and production
operations automation are not connected.

## Named executable evidence

`npm run verify:migration-closure` validates both source anchors and shared-gate
reachability:

- E01-E03 are live Go test functions in
  `backend/cmd/notes/runtime_closure_integration_test.go`, selected by
  `go:test:integration` through `./cmd/notes`;
- E04 is the exact Playwright test `live disposable account deletion survives
an actual Go restart`, selected only by the dedicated destructive config;
- E05 is the exact `scripts/verify-release-artifact.mts` invocation reached by
  `verify:release`.

Skipped, focused-only, expected-failure, commented/string-only, duplicated, or
shell-masked evidence cannot satisfy closure. The root `verify` script must
reach each child gate through reviewed command segments; `||`, pipelines,
backgrounding, and inert `echo` text do not count.

## Actual-process evidence

E01-E03 build and start the real `notes` and `notesctl` commands. Each profile
checks the exact route status/body/header matrix, authentication before body,
CSRF/origin rejection, body bounds, foreign-owner denial, and log redaction.
It sends `SIGTERM` and requires a zero exit plus the structured shutdown record
on every cycle.

Each profile runs two server cycles against the same prepared state without a
second seed. The second cycle proves persisted Sync/legacy identity, legal
consent, commerce/cancellation evidence, privacy journal state, encryption
envelopes, and cursors rather than merely repeating response shape. Local
fixture profiles hold the cooperative host lock plus PostgreSQL advisory lease;
a contender cannot start or mutate the fixture. The private-legacy profile is
serialized by the test harness but does **not** own that local-fixture runtime
lease, so this evidence must not be read as a lease guarantee for it.

The cooperative host lock assumes Notes/notesctl processes do not unlink or
rename the fixed lock namespace. A hostile same-UID process can already mutate
the disposable fixture and is outside this local/test threat boundary.

## Destructive fixture lane

Normal shared E2E forces legal policy `undecided`; ambient environment cannot
open deletion. The dedicated lane is excluded from normal Playwright discovery
and requires the exact invocation-level confirmation before it creates or
prepares anything:

```sh
FUKAMU_DELETION_E2E_CONFIRM=delete-live-evidence \
npm run test:e2e:deletion-live
```

That standalone command performs the frontend build itself. Prebuilt mode is
valid only after an explicit `npm run build` in the same checkout:

```sh
npm run build
FUKAMU_E2E_USE_PREBUILT=1 \
FUKAMU_DELETION_E2E_CONFIRM=delete-live-evidence \
npm run test:e2e:deletion-live
```

The direct child script contains no automatic confirmation. It creates fresh
IDs, secrets, database seed, filesystem root, and browser state, uses one
Chromium worker, blocks non-loopback HTTP(S), and makes no external provider
request. The test proves a Go Sync write, Start/revocation, immediate browser
quiescence/purge, an actual Go restart while the saga is pending, fenced Sync,
terminal completion, a second restart, and no cookie/IndexedDB/private-cache or
server-data resurrection. This is disposable local evidence, not a legal
policy, production deletion approval, or production retention design.

## Production-disabled artifact evidence

E05 is release-manifest schema/verifier v2. It binds an immutable Docker image
ID, exact production-disabled route bytes/headers for all 13 OpenAPI operations,
one minimal-environment loopback smoke, and exactly two distinct
`--network=none` lifecycle records. See
[`go-release-artifact.md`](go-release-artifact.md).

The production transition is recorded as `not-performed` for deployment,
database migration, traffic cutover, and external resources, with approval
pending. A green closure gate means the inventory and executable links are
internally consistent; the separate #525 artifact completes V12 only for the
approved local scope and does not mean production migration is complete.

## Remaining approval and implementation boundaries

No public OIDC/OTP/signup HTTP composition, production identity provider,
Stripe webhook/charge provider, production PostgreSQL/objects/KMS/backup,
privacy verifier/fulfillment processor, scheduler/realtime service,
hosting/domain/TLS, or production legal-evidence policy is selected here.
Provider IAM, quota/cost, real backup recovery, observability/SLO, and on-call
ownership also remain unresolved. These are explicit absent or approval-pending
inventory, not hidden completion claims.

Issue #525 closes V12 for the approved local scope with five independent runs
per adopted cell: the reference/Go legacy API at 100/1,000/10,000 cards, native
UI at 100/10,000 cards, and a separate 10,000-entry Sync v2 traversal plus 100
independent concurrent vault requests. Raw data, summaries, source identities,
reproduction, and limitations are in
[`migration-v12-performance.md`](migration-v12-performance.md). Direct API
comparisons had no errors or parity failures and stayed inside the provisional
review envelope. The current native UI 10,000-card initial load is a recorded
large-dataset UX limitation because it traverses 20 ordered Sync v2 pages; it
must not be restated as Go API regression or hidden as a passing capacity SLO.
T01 and T14 are complete only for this approved local/provider-independent
scope. Production-shaped capacity, provider exercise, deployment, and cutover
remain unverified and approval-blocked under T15/T16.

Cutover, rollback, and data-recovery rules are in
[`production-operations-runbook.md`](production-operations-runbook.md). The old
TypeScript source-retirement boundary is in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md).
