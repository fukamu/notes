# Connections full-network Chromium Worker feasibility (Issue #310)

## Decision

The phase-2 staging removal is blocked. The production-equivalent Chromium
Worker produced no geometry for any required full-network case. Each case
failed inside elkjs 0.12.0 with `RangeError: Maximum call stack size exceeded`.
This reproduces the phase-0 Node failure at the actual browser Worker boundary;
moving the same ELK work off the main thread does not make the complete graph
executable.

Do not remove the 64/256 staging policy or claim 10k full-network support on
this evidence. Issue #311 remains blocked until a separately approved layout
architecture can produce complete geometry for the same inputs. Restoring a
different cap, sampling edges, or treating the error fallback as the complete
map would change the requirement and is not an acceptable workaround.

## Fixed conditions

- Branch point: `084e9d789eb7a6c77e7ea27ddc579dac459ec75d`
- Browser: Chromium 153.0.8010.12, 1280x720, DPR 1
- Worker: the installed `elkjs/lib/elk-worker.min.js` source in a real Blob
  Worker
- Layout adapter: the production `createConnectionsLayoutRunner`
- Settings: layered, RIGHT, ORTHOGONAL, FREE ports, separated connected
  components, thoroughness 7, unmerged edges
- Limit: one 30-second research guard per case; failures and timeouts are not
  passes
- Complete input: the phase-0 fixed-seed generators feed the full graph directly
  to the runner without `selectConnectionsStage`

The test-only Blob URL avoids coupling the measurement to an emitted asset
path while preserving the shipped elkjs Worker source and production graph
conversion, decoding, metrics, and ELK settings. The first attempted harness
used the product `?url` adapter inside an in-memory IIFE; its generated asset URL
could not initialize there, so those preparation timeouts were discarded as a
harness error and are not product evidence.

## Results

| Fixture                      |                  Full input |      Maximum weak component | Worker preparation | ELK wall time to failure | Result                      |
| ---------------------------- | --------------------------: | --------------------------: | -----------------: | -----------------------: | --------------------------- |
| representative mixed         |   1,000 nodes / 3,000 edges |     600 nodes / 1,253 edges |            66.6 ms |               2,570.1 ms | stack overflow; no geometry |
| existing product fixture     | 10,000 nodes / 19,951 edges | 10,000 nodes / 19,951 edges |            64.4 ms |               1,142.1 ms | stack overflow; no geometry |
| connected fixed-seed fixture | 10,000 nodes / 20,000 edges | 10,000 nodes / 20,000 edges |            67.6 ms |               1,144.0 ms | stack overflow; no geometry |

No case reached output decoding, path generation, identity comparison, React
commit, paint, or full-fit rendering. Therefore there is no successful sample
from which to set initial-layout, DOM, or memory budgets. The observed
`performance.memory` value stayed at 23,100,000 bytes, but browser heap
reporting is observational and a failed layout cannot establish a usable
memory budget. Every Worker was terminated after the case.

The raw environment, timings, inputs, failure stacks, null geometry, identity
flags, heap observations, and lifecycle results are stored in
[`connections-browser-worker-feasibility.json`](benchmarks/connections-browser-worker-feasibility.json).

## Consequence for the execution plan

Stage 1 can finish independently: graph projection reuse, stale-result safety,
and tombstone visibility are valid with the staged renderer and reduce or avoid
unnecessary work.

The phase-2 product cutover cannot proceed with the recommended single-ELK
design. The next decision is architectural, not a conditional tuning step:

1. evaluate a different layout/routing algorithm for complete large connected
   graphs, or
2. explicitly change the product requirement to a clustered/nearby mode.

Component caching alone cannot solve the two required single-component 10k
cases. SVG culling, dynamic zoom, cache weighting, and lower thoroughness also
cannot recover geometry that ELK failed to produce, so Issue #310 does not
select those optimizations.

## Selected follow-up architecture

Issue #316 subsequently selects and implements the pure core for the approved
alternative: keep the current ELK route for small complete graphs, and use a
deterministic weak-component grid plus individual corridor routing above the
reviewed calculation boundary. Both engines receive the complete input and
produce the same `ConnectionsLayout` contract; the boundary is not a display
cap. See
[`connections-corridor-layout.md`](connections-corridor-layout.md).

This follow-up does not reinterpret the failures above as successes. Issue #316
establishes pure-core geometry only. Browser Worker lifecycle, the hybrid ELK
deadline/fallback path, full-network UI cutover, paint performance, and visual
review remain later gates before Issue #311 can remove staging.

## Reproduction

```bash
CONNECTIONS_BROWSER_WORKER_FEASIBILITY=1 npx --no-install playwright test tests/e2e/connections-worker-feasibility.spec.ts --project=chromium
npx --no-install vitest run tests/unit/connections-browser-worker-feasibility.test.ts tests/unit/connections-full-network-baseline.test.ts
npm run verify
```

The explicit environment flag keeps the three-case research measurement out of
ordinary E2E runs. It was run for this Issue and the raw artifact is checked in;
the ordinary suite still type-checks the harness and records the opt-in test as
skipped rather than treating a skipped benchmark as successful evidence.
