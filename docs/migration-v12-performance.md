# V12 local performance evidence

Issue #525 closes the provider-independent, local V12 evidence scope. The raw
artifact is
[`benchmarks/migration-v12-local.json`](benchmarks/migration-v12-local.json).
It is diagnostic migration evidence, not a production capacity claim, SLO, or
permission to deploy.

## Fixed identities and conditions

- Go measurement revision: `98f720740fa4939c56e5ff10e4b29e7514a3decd`
- integration branch point: `fa33eb8536c309e350c2617642b82ae38a096aa7`
- runnable pre-migration reference: `f423da9932163980485ecc5bc2055b7c8c3b3d8b`
- retired TypeScript source ledger: `e8936ab90768774371d84b4808c100d546649943`
- host: Linux x64, 8 logical CPUs, 16.46 GB RAM; Node 24.21.0,
  Go 1.27.0, PostgreSQL 18.6, Wrangler 4.92.0, Miniflare
  4.20260515.0, and Chromium 153.0.8010.12
- stores: a new isolated local D1 store for every reference run and a freshly
  migrated logical schema in the dedicated loopback PostgreSQL test database
  for every Go run; the two targets never share or dual-write a store
- effects: loopback D1/PostgreSQL and private-directory adapters only; no
  remote provider, production data, external resource, or charge
- sampling: one warm-up before every warm full-sync sample and five
  independent runs for every adopted cell; cold means a fresh application
  process and logical store, while the host OS cache is uncontrolled

The artifact binds source and built-runtime SHA-256 digests. It records every
run, response digest, status, duration, query count, and applicable RSS/PSS.
`npm run verify:migration-v12-evidence` recomputes summaries, result parity,
review outcomes, source identity, and safety invariants. The verifier is an
explicit #525 procedure and is deliberately not part of the ordinary root
`npm run verify` gate.

## Direct backend comparison

The backend comparison uses the same legacy Sync v1 operations and logical
fixtures against the reference D1 handler and the Go/PostgreSQL handler. It
covers 100, 1,000, and 10,000 cards, cold/full and warm/full sync, a normal
single save, a 500-mutation batch, and a two-device conflict. All 30 run cells
returned the expected status, all reference/Go final-state digests matched,
and all 12 reviewed warm-operation comparisons were inside the provisional
local p95 envelope.

The largest fixture is summarized below. Range and coefficient of variation
(CV) are derived from the five raw durations. Query count is the maximum for
one measured operation.

| Target    | 10,000-card operation |    p50 ms |    p95 ms |   Five-run range ms |    CV | Max queries | Errors |
| --------- | --------------------- | --------: | --------: | ------------------: | ----: | ----------: | -----: |
| reference | cold start            | 1,256.248 | 1,285.604 | 1,039.962–1,285.604 |  7.4% |           0 |    0/5 |
| reference | cold full sync        |   244.396 |   251.073 |     201.071–251.073 |  7.8% |           3 |    0/5 |
| reference | warm full sync        |   183.868 |   187.617 |     150.807–187.617 |  7.8% |           3 |    0/5 |
| reference | single mutation       |   320.902 |   345.901 |     268.926–345.901 |  8.2% |          10 |    0/5 |
| reference | batch 500             | 3,646.896 | 3,692.599 | 3,493.781–3,692.599 |  2.4% |       2,505 |    0/5 |
| reference | two-device conflict   |   640.823 |   659.426 |     541.158–659.426 |  8.6% |          20 |    0/5 |
| Go        | cold start            |    33.388 |    34.446 |       32.998–34.446 |  1.6% |           0 |    0/5 |
| Go        | cold full sync        |   139.280 |   144.693 |     115.337–144.693 | 10.0% |           8 |    0/5 |
| Go        | warm full sync        |   135.771 |   137.107 |     105.065–137.107 |  9.6% |           8 |    0/5 |
| Go        | single mutation       |   138.502 |   144.329 |     106.293–144.329 | 10.2% |          12 |    0/5 |
| Go        | batch 500             |   288.523 |   300.077 |     233.992–300.077 |  8.6% |       2,009 |    0/5 |
| Go        | two-device conflict   |   294.565 |   318.089 |     233.388–318.089 | 10.1% |          24 |    0/5 |

At 10,000 cards the maximum observed process-group PSS was 886.0 MB for the
reference Wrangler/Miniflare group and 43.9 MB for the Go group. These values
describe their complete local runtime groups; they are not an isolated
language-runtime allocation comparison.

## Native UI observation

The native connected UI was measured at 100 and 10,000 cards with the same
logical card data and headless Chromium conditions. This is a user-perceived
check, not protocol parity: the reference UI calls legacy Sync v1, while the
current UI obtains session context and traverses Sync v2 pages.

| Target    |  Cards | Operation            |    p50 ms |    p95 ms |   Five-run range ms |    CV | Errors |
| --------- | -----: | -------------------- | --------: | --------: | ------------------: | ----: | -----: |
| reference |    100 | initial ready        |   307.153 |   345.079 |     243.162–345.079 | 14.2% |    0/5 |
| Go        |    100 | initial ready        |   230.803 |   295.145 |     223.594–295.145 | 12.5% |    0/5 |
| reference | 10,000 | initial ready        |   895.554 |   921.634 |     658.388–921.634 | 11.5% |    0/5 |
| Go        | 10,000 | initial ready        | 2,533.020 | 2,567.181 | 1,992.102–2,567.181 |  9.2% |    0/5 |
| reference | 10,000 | save acknowledgement | 1,162.119 | 1,209.995 |   998.215–1,209.995 |  6.4% |    0/5 |
| Go        | 10,000 | save acknowledgement |   565.423 |   570.476 |     532.040–570.476 |  2.5% |    0/5 |

The 10,000-card current initial-ready p95 is outside the provisional envelope
by 1,461.220 ms. All five runs reproduce the difference. The raw network
record explains the path difference: reference startup is one `/api/sync`
request, whereas current startup is one `/api/session-context` request plus 20
ordered `/api/v2/sync` pages of 500 changes. All 21 current requests returned
200, the replica contained exactly 10,000 cards, and the corresponding Go
backend full traversal had zero errors or missing entries. Therefore this is
recorded as a current large-dataset initial-load UX limitation, not attributed
to Go API regression and not hidden by relaxing the review envelope. Its
production impact remains unverified until a separately approved
production-shaped environment exists; increasing the protocol page limit or
redesigning the UI was outside #525.

## Sync v2 load evidence

Sync v2 has no equivalent connected legacy route, so it is a separate Go-only
measurement. Each of five runs traversed 10,000 encrypted changes in 20 pages
of 500, repeated the fixed-high-watermark traversal, and fetched a one-change
delta. A separate five-run wave sent 100 simultaneous requests for 100
independent vault/session/device scopes with a PostgreSQL pool limit of 16 and
no application serialization shim.

| Operation             | Samples |    p50 ms |    p95 ms |   Five-run range ms |    CV |          Max queries | Errors |
| --------------------- | ------: | --------: | --------: | ------------------: | ----: | -------------------: | -----: |
| cold 10,000 traversal |       5 | 1,373.417 | 1,518.668 | 1,275.432–1,518.668 |  7.1% |               10,280 |    0/5 |
| warm 10,000 traversal |       5 | 1,443.854 | 1,506.034 | 1,277.730–1,506.034 |  7.0% |               10,280 |    0/5 |
| one-change delta      |       5 |     1.588 |     1.921 |         1.566–1.921 |  8.0% |                   15 |    0/5 |
| 100-request wave      |       5 |   743.963 |   867.991 |     648.967–867.991 | 10.6% | recorded per request |    0/5 |

Across the five waves all 500 requests succeeded and produced 500 durable
commits, cards, encrypted metadata rows, quota reservations, object writes,
and encryptions. Maximum observed HTTP/application concurrency was 100,
database concurrency was 16, tenant-scope violations were zero, and concurrent
PSS peaked at 58.8 MB. Traversals had no missing or duplicate changes and kept
a fixed high watermark.

## Reproduction and cleanup

Use only the dedicated loopback test database. Reproduce from the exact
measured revision, where the artifact had not yet been added, and prepare the
exact reference at the path required by the runner. Install each revision's
locked dependencies before measuring:

```sh
git worktree add --detach /tmp/notes-v12-reference-f423 f423da9932163980485ecc5bc2055b7c8c3b3d8b
npm --prefix /tmp/notes-v12-reference-f423 ci
git worktree add --detach /tmp/notes-v12-reproduce 98f720740fa4939c56e5ff10e4b29e7514a3decd
npm --prefix /tmp/notes-v12-reproduce ci
cd /tmp/notes-v12-reproduce
docker compose -f deploy/compose.test.yaml up -d --wait
FUKAMU_V12_PERFORMANCE_CONFIRM=local-disposable-only \
NOTES_TEST_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
npm run benchmark:migration:v12
npm run verify:migration-v12-evidence
docker compose -f deploy/compose.test.yaml stop postgres
```

The runner owns and removes its marked temporary D1, build, key, and fixture
directories on success or failure and restores the exact reference handler
after observation. Stopping PostgreSQL preserves the dedicated test volume;
no existing, production, or external database is deleted.
