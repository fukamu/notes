# Connections full-network phase 0 baseline

> Follow-up: Issue #310 reproduced the full-graph stack overflow in the actual
> Chromium Worker for the 1k/3k and both 10k inputs. See
> [`connections-browser-worker-feasibility.md`](connections-browser-worker-feasibility.md).
> Issue #318 later supplied complete product-Worker geometry and Issue #311
> removed staging. This file remains the immutable failed-ELK baseline; current
> UI evidence is in
> [`connections-full-network-cutover.md`](connections-full-network-cutover.md).

Issue #305 records the feasibility baseline for parent #304. It does not change
the product path: the shipped adapter still stages 64 nodes initially and 256
at maximum. The fixed analysis commit and the latest canonical integration tip
were both `4a2780153bcdef82cd650d19f3c8c58b94f7944f`; their commit and file diffs
were zero when this work began.

The machine-readable Node evidence is
[`connections-full-network-baseline.json`](benchmarks/connections-full-network-baseline.json).
The current product's browser evidence is
[`connections-10k-staged-browser-baseline.json`](benchmarks/connections-10k-staged-browser-baseline.json).

## Runtime and scope baseline

`app/(notes)/layout.tsx` still mounts `LegacyNotesApp`. The authenticated
`SessionNotesApp` and Vault-scoped Sync v2 runtime exist as a separate
composition. “All cards” therefore means the active provider's permitted,
single-scope visible replica. It never means a union across accounts, Vaults,
or databases.

Sync v2 requests pages until the terminal page and commits the collected plan
once. A focused test now protects 501 changes split across a 500-change
intermediate page and a terminal page. Online completeness requires that
terminal success; `initial-sync-completed` alone is not proof because the UI
lifecycle also settles after failure. Offline mode can claim only the retained
local replica.

## Method

The comparison fixes the production metrics and ELK configuration:

- A: `selectConnectionsStage(..., { expansionPage: 0 })`, the current product
  membership.
- B: the complete `selectConnectionsViewModel` result before staging.
- ELK 0.12.0, `layered`, `RIGHT`, `ORTHOGONAL`, `FREE`,
  `separateConnectedComponents=true`, and `thoroughness=7`.
- One warm-up and five retained samples. No outlier is removed.
- Every ELK case runs in a child Vitest process. It writes partial progress
  before a potentially blocking layout and is killed after 30 seconds. Timeout,
  failure, and partial samples are evidence, never a pass.
- Large-case wall-clock excludes pairwise route-quality analysis. Path timing
  uses only the production curve function over the returned sections.

The final Node artifact used the CI version, Node 22.13.0, on Linux
7.0.0-31-generic with an 11th Gen Intel Core i7-1195G7, 8 logical CPUs, and
16,463,347,712 bytes of RAM. The same stack failures were first reproduced on
the host's Node 26.8.1 before the exact-version rerun.

## Input and staging cost

The typed semantic input remains inexpensive relative to layout. These values
are medians with their retained p95 in parentheses:

| Fixture              |                            Full shape |     Semantic input |    Current staging |
| -------------------- | ------------------------------------: | -----------------: | -----------------: |
| 257 mixed            | 257 nodes / 256 edges / 35 components |   0.182 ms (0.213) |   0.125 ms (0.132) |
| 1,000 mixed          |                    1,000 / 3,000 / 53 |   1.777 ms (2.520) |   0.847 ms (1.977) |
| Existing product 10k |                   10,000 / 19,951 / 1 | 14.588 ms (16.979) | 15.605 ms (15.944) |
| Connected 10k        |                   10,000 / 20,000 / 1 | 13.751 ms (27.839) | 14.295 ms (15.517) |

The 64/65 and 256/257 fixtures prove the membership discontinuity. B retains
all node IDs and directed endpoints. A retains 64 nodes once the source exceeds 64. The mixed 257 fixture contains two connected components and 33 isolated
nodes; B retains all 35 components while A retains only the current component's
first 64 nodes.

## ELK feasibility result

| Fixture                       | A staged layout median (p95) | B full layout median (p95) | B result              |
| ----------------------------- | ---------------------------: | -------------------------: | --------------------- |
| 64 connected                  |           33.704 ms (50.478) |         33.844 ms (42.201) | completed             |
| 65 connected                  |           30.940 ms (50.983) |         40.526 ms (48.615) | completed             |
| 256 connected                 |           30.850 ms (41.957) |        94.973 ms (140.484) | completed             |
| 257 connected                 |           34.906 ms (45.562) |        84.396 ms (128.440) | completed             |
| 257 mixed, 35 components      |           51.602 ms (90.119) |   1,276.225 ms (1,333.165) | completed             |
| 1,000 / 3,000 mixed           |          60.386 ms (110.765) |                  no sample | failed before warm-up |
| Existing product 10k / 19,951 |           60.643 ms (87.216) |                  no sample | failed before warm-up |
| Connected 10k / 20,000        |           54.301 ms (87.814) |                  no sample | failed before warm-up |

All three larger B cases failed inside `elkjs/lib/elk.bundled.js` with
`RangeError: Maximum call stack size exceeded`; the 1k case failed after about
3.9 seconds of child-process wall time and both 10k cases after about 2.3
seconds. They did not time out, produce geometry, generate paths, enter React,
or reach browser paint. The artifact retains the stack prefixes and zero sample
counts.

This is a failure of the plan's first candidate on the reference Node runtime,
not proof that a browser Worker has an identical stack limit. It is sufficient
to block removal of staging: there is currently no successful 1k or 10k B
geometry to render. A browser-Worker experiment must preserve the same full
membership and 30-second failure accounting before it can overturn this result.

## Current browser A

The existing 10k staged product path was rerun in Chromium 153.0.8010.12:

| Project           | Viewport / DPR  | Initial ready | Expansions to 128 / 192 / 256  | Re-entry at 64 |
| ----------------- | --------------- | ------------: | ------------------------------ | -------------: |
| Desktop Chromium  | 1280×720 / 1    |  1,160.848 ms | 281.452 / 389.128 / 885.966 ms |     163.386 ms |
| Pixel 7 emulation | 412×839 / 2.625 |  1,123.698 ms | 351.744 / 383.964 / 883.729 ms |     119.858 ms |

The final re-entry mounted 64 card buttons, 129 SVG paths, and 64 semantic edge
items within 519 graph descendants. The heap observations were 50.4 MB and
53.5 MB. These are observational single samples for A, not a 10k full-layout or
full-render claim. The existing readiness and gesture tests continue to own
long-task, frame-gap, rAF transform, pointer, keyboard, and touch coverage.

## Reproduced correctness findings

Two plan hypotheses reproduced deterministically:

1. Controller A→B→A: returning to settled A does not invalidate active B.
   When B resolves, the controller accepts B's key/geometry against the latest
   A semantic input. This requires a focused correctness Issue before all-node
   cutover. It does not by itself justify a latest-only scheduler; request
   coalescing remains conditional on measured accumulation.
2. Sync v2 tombstone visibility: with current `[A, B]`, merged `[A]`, and no
   edit newer than the request snapshot, `reconcileVisibleCardsAfterSync`
   appends B from `remainingLocal`. Repository deletion can therefore be
   followed by UI reappearance. A separate minimal Issue must distinguish a
   confirmed deletion from an edit created during the request.

## Decisions for later phases

- Required regardless of layout choice: fix the A→B→A acceptance bug and the
  reproduced tombstone visibility bug in separate implementation Issues.
- Not selected: `thoroughness=3/1`. The target B cases fail before a measured
  layout; there is no evidence that reducing quality effort fixes the recursive
  failure or preserves route quality.
- Not selected: edge/node culling, AABB tree, weighted layout cache, larger LRU,
  or semantic accessibility virtualization. None can create missing 1k/10k
  geometry, and B never reached DOM or paint.
- Not selected: component cache/packing. The existing product 10k fixture and
  the explicit 10k fixture are each one weakly connected component, so
  component reuse does not remove their first-layout failure.
- No Canvas/WebGL or alternate router/layout is authorized by this evidence.
  Those are higher-cost alternatives and require a separate product/architecture
  decision after a browser-Worker reproduction.

The phase-0 outcome is therefore **blocked feasibility, not 10k completion**.
Stages 1 and the sync prerequisite may fix independently reproduced correctness
work. Stage 2 must not remove staging until an approved layout path produces
complete 1k and 10k geometry within recorded budgets. `main`, deployment, and
production data remain unchanged.

## Verification commands

```bash
npx --no-install vitest run tests/unit/connections-full-network-baseline.test.ts tests/unit/sync-v2-client.test.ts tests/unit/client-reconciliation.test.ts tests/unit/connections-controller.test.ts
npm exec --yes --package=node@22.13.0 -- node node_modules/vitest/vitest.mjs run tests/benchmarks/connections-full-network-baseline.benchmark.test.ts --config vitest.benchmark.config.ts --disableConsoleIntercept
npm run test:e2e -- --grep '10k connections bounds layout'
```

The Issue also requires `git diff --check` and `npm run verify` before merge.
