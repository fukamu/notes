# Connections hybrid layout Worker (Issue #318)

## Decision

The product layout adapter now keeps the existing ELK Worker for complete
graphs at or below 256 nodes and 1,024 directed edges, and uses the corridor
Worker above either calculation boundary. Both engines receive the complete
input graph. These values select an engine; they are not display limits.

The browser adapter retains one active calculation and at most one not-yet-
started latest calculation. It announces the desired layout key before the
four-entry cache lookup, so returning to cached A while B is queued rejects B
without disturbing a shared active A. Replaced and reset requests always settle
with a typed error; rejected cache entries remain retryable.

The shared key contains ordered node IDs, ordered directed endpoints, layout
metrics, and the hybrid policy revision. Selection, labels, camera state, and
other semantic-only values remain outside the geometry key.

## Worker boundary and lifetime

The corridor engine runs only in its application-owned module Worker. Its RPC
uses a discriminated protocol with request ID, manager generation, policy
revision, complete graph, metrics, and corridor options. The client treats each
response as unknown and validates:

- compatible policy and generation;
- exact node and edge counts and input order;
- directed endpoints and stable edge/section/port identities;
- two independently owned ports per edge;
- finite, non-negative geometry inside the returned world bounds.

The product executor creates ELK or corridor lazily. A small-graph ELK request
has a 2,000 ms preparation-plus-layout deadline. ELK failure or expiry
terminates that ELK Worker and submits the same unmodified graph to corridor
once. A successful fallback is cached; a failed request is evicted. A late ELK
result cannot win the already-settled job. Logout/reset increments the manager
generation, rejects tracked and queued work, and terminates both Workers;
completion handlers cannot create a fallback after reset.

The Service Worker preparation list contains both emitted Worker assets. The
pure corridor core, key generation, scheduler, controller, and cache remain
free of browser APIs; Worker, clocks, and termination are confined to the
client adapter.

## Chromium product-path evidence

The explicit Issue #318 Chromium run bundles the real corridor Worker entry and
passes all inputs through `createConnectionsLayoutWorkerManager` and the
production hybrid browser executor. The saved run used Chromium 153.0.8010.12,
1280×720, DPR 1, Linux, an i7-1195G7 host with eight logical CPUs and about
16.5 GB RAM. Each case had a 30-second research guard.

| Fixture              |           N / E | Manager layout wall | Worker layout | transfer/scheduling remainder | response decode | curve preparation |
| -------------------- | --------------: | ------------------: | ------------: | ----------------------------: | --------------: | ----------------: |
| boundary mixed       |       257 / 256 |             15.7 ms |        5.7 ms |                        2.9 ms |          1.8 ms |            2.2 ms |
| representative mixed |   1,000 / 3,000 |             67.4 ms |       29.7 ms |                       21.7 ms |         10.6 ms |            8.9 ms |
| product existing     | 10,000 / 19,951 |            405.7 ms |      173.7 ms |                      138.0 ms |         70.9 ms |           44.3 ms |
| connected            | 10,000 / 20,000 |            339.4 ms |      132.7 ms |                      142.9 ms |         50.7 ms |           44.0 ms |

All four results retained every node and directed edge in input order, returned
two ports per edge, generated finite curve data, and reset the Worker manager
after completion. The transfer/scheduling value is the non-negative round-trip
remainder after Worker layout and response decode; it is not claimed as a pure
structured-clone measurement.

The complete environment and raw values are saved separately in
[`connections-hybrid-worker-feasibility.json`](benchmarks/connections-hybrid-worker-feasibility.json).
The earlier raw ELK stack-overflow artifact remains unchanged historical
evidence.

## Evidence boundary and next step

This result establishes full geometry through the product Worker manager. It
does not remove the current 64/64/256 staging UI, render 10,000 cards or SVG
paths in React, measure commit/paint or camera frames, or establish visual
equivalence between large corridor and small ELK layouts. Memory values exposed
by headless Chromium were flat observational readings and are not a Worker
memory budget.

Issue #311 subsequently cut the UI over to complete input, implemented
whole-world camera limits and safe visibility selection, and demonstrated that
whole-world SVG/paint misses the provisional product target. See
[`connections-full-network-cutover.md`](connections-full-network-cutover.md).
That evidence activates the separately reviewed Canvas 2D edge evaluation.
`main`, deployment, and Sites remain outside this decision.
