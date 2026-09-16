# ADR 005: Full-network semantic zoom uses a retained overview layer

- Status: accepted for parent Issue #283
- Date: 2026-09-16
- Decision owner: benchmark and architecture Issue #285
- Baseline commit: `4341bed780b0fd2d797f5bef3505fd64c3670495`
- Evidence: [`full-network-semantic-zoom.json`](../benchmarks/full-network-semantic-zoom.json)

## Context

The connections view must return from the current-card/256-card staged view to a
complete network. Every card, isolated component, and unique directed link remains
represented. Search is not a substitute for the paper-Zettelkasten overview. At
the same time, mounting 10,000 DOM cards or asking ELK Layered to construct a port
and orthogonal route for every link is not a viable global-view architecture.

The product envelope is 10,000 active cards, 8 KiB serialized plaintext per card,
and about 128 MiB per Vault. The canonical content codec fits 116 unique link
segments in 8,169 bytes; a 117th uses 8,239 bytes. The deliberately hostile but
quota-valid graph therefore has 10,000 nodes and 1,160,000 directed edges. The
existing repeatable fixture has 10,000 nodes and 19,951 valid directed edges.

The benchmark also covers empty, one-node, all-isolated, disconnected, chain,
cycle, self-link, mutual-link, star, and high-degree graphs. It uses only synthetic
content and makes no network or production-data request.

## Decision

Use two coordinated layers, both derived from one complete typed graph:

1. A worker computes deterministic component-aware positions from packed numeric
   node/edge arrays. The selected baseline is component BFS plus serpentine
   component packing. It won the predefined hard-geometry then minimax p95/max
   normalized-link-length ordering over the representative and dense graphs.
2. A retained overview raster contains every global edge and node. WebGL2 is the
   primary renderer. The canvas is transformed by the camera without redrawing
   the complete graph for each pan or zoom. Canvas2D remains a progressively built
   fallback; it is not used as a synchronous all-edge redraw loop.
3. At closer zoom levels, a viewport-derived detail layer adds card shapes,
   labels, hit targets, direction styling, and node-safe routes. Its spatial query
   decides detail, not existence: the retained overview continues to represent
   every node and edge. Zoom never changes graph membership.

No graph sampling, edge cap, hidden card limit, or connections search is introduced.
At the outermost level, coincident pixels intentionally communicate density; an
individual link becomes distinguishable after zooming. “All links” means every
semantic edge contributes to the overview and retains its identity for detail,
not that 1.16 million overlapping one-pixel strokes are individually legible at
fit-to-screen scale.

The overview is regenerated only when topology or layout changes. Card title/body
editing, camera motion, selection, and hover must not trigger global layout or a
full redraw. Generation is coalesced, cancellable by operation/session epoch, and
performed outside the React render path. WebGL context loss rebuilds from the
typed graph; failure must be explicit and must never silently omit edges.

Do not add a graph-rendering package for this implementation. WebGL2,
OffscreenCanvas, typed arrays, the existing worker boundary, and the existing
camera are sufficient. `elkjs` 0.12.0 remains available for bounded detail routes;
it is not the global 10k layout engine. Its installed declaration remains
`EPL-2.0 OR GPL-3.0-or-later`, and this decision adds no runtime dependency or
production bundle bytes by itself.

## Evidence

The committed raw artifact contains every sample. Timings are reference-host
evidence, not universal service-level objectives. The browser was Playwright
Chromium using ANGLE with SwiftShader, not a hardware GPU.

### Layout and transfer

| Graph                 | Selected layout median / p95 | Packed graph bytes | Structured-clone median / p95 |
| --------------------- | ---------------------------: | -----------------: | ----------------------------: |
| 10k / 19,951 edges    |             3.018 / 3.189 ms |            159,608 |              0.041 / 0.094 ms |
| 10k / 1,160,000 edges |           50.433 / 51.350 ms |          9,280,000 |              3.175 / 4.605 ms |

Every candidate returned finite, unique positions for all 10,000 nodes without
mutating the input. The selected candidate's worst normalized p95/max link lengths
were 81.664/105.730, versus 92.418/139.386 for identity and DFS order. Across the
two scale graphs its deterministic crossing sample was 385,221 versus 630,763,
and its node-intrusion sample was 6,871 versus 7,187. On the representative graph
alone BFS has more sampled crossings and intrusions than identity order; that cost
is retained rather than hidden. Issue #287 must improve the visible-detail route
without changing global membership.

### Rendering and camera reuse

| Graph                 | Canvas full-redraw gap median / p95 | WebGL full-redraw gap median / p95 | Retained camera gap median / p95 |
| --------------------- | ----------------------------------: | ---------------------------------: | -------------------------------: |
| 10k / 19,951 edges    |                      48.3 / 49.8 ms |                     36.1 / 39.5 ms |                   16.8 / 17.0 ms |
| 10k / 1,160,000 edges |                2,291.5 / 2,293.5 ms |               1,742.3 / 1,744.5 ms |                   16.8 / 16.8 ms |

The dense WebGL vertex buffers use 18,640,000 bytes and represent all 1,160,000
edges plus all nodes. Both candidates also retain a 1,280 × 720 RGBA backing store
of 3,686,400 bytes in this harness. The same Chromium worker reported both
OffscreenCanvas and WebGL2 support. This proves the boundary on the reference
environment, not every browser. The multi-second software-rendered dense first
raster is unacceptable as a per-camera redraw but can be an explicit, cancellable
first-build state followed by compositor camera reuse. The production browser
benchmark must keep both first-ready and retained-camera measurements; a quick
JavaScript submission time must not be reported as paint completion.

## Stable budgets and gates

These are structural gates, not host-clock gates:

- exactly 10,000/19,951 and 10,000/1,160,000 node/edge identities enter layout and
  rendering in the two scale fixtures;
- packed topology is O(V + E), at most 9,280,000 bytes for the measured dense
  source/target arrays, with no title or body copied to the worker;
- base WebGL position geometry is O(V + E) and exactly 18,640,000 bytes for the
  measured dense fixture; added style/index buffers must be separately reported;
- placement is finite, deterministic, input-immutable, and has no duplicate node
  positions; all isolated and disconnected components are retained;
- camera input does not invoke global layout, rebuild edge vertices, or redraw all
  edges; global rebuilds are coalesced by topology/layout version;
- the overview renderer accounts for every edge; detailed visibility culling may
  reduce labels/card DOM/routes but never the overview topology;
- capability loss, worker failure, context loss, and stale-session results fail
  explicitly and preserve the last valid graph or a recoverable status.

Wall-clock samples must be compared on the same host and kept raw. No fixed
five-second or frame-time completion rule is added by this ADR. A production change
that increases packed topology or base position-buffer bytes beyond the formulas
above must explain the new per-node/per-edge fields rather than weakening a test.

## Alternatives rejected

- **Current-card/256-card staging:** bounded, but directly contradicts the complete
  network decision.
- **10,000 DOM nodes plus SVG paths:** makes DOM and accessibility-tree size scale
  with all nodes/edges and defeats semantic detail virtualization.
- **Full ELK global routing:** the current input allocates per-edge ports and rich
  objects. It remains useful for bounded detail but is not needed for the overview's
  density layer.
- **Canvas2D full redraw on every camera event:** the dense visible-frame evidence
  is worse than WebGL and blocks retained-camera reuse as an explicit invariant.
- **Identity or DFS packing:** both have worse worst-fixture p95/max link length and
  aggregate sampled crossings in the measured corpus. DFS also took materially
  longer on the dense graph.
- **Graph/edge sampling:** faster, but violates the approved all-network contract.

## Consequences and remaining risks

The implementation must manage a WebGL lifecycle, capability fallback, context
loss, and an overview/detail transition. Pixel density means links can be visually
indistinguishable at fit scale; this is expected aggregation by projection, not
data removal. Straight overview segments still cross nodes and each other. Routing,
spatial indexing, labels, direction cues, accessibility, reduced motion, and
failure UX remain in Issues #287–#290 and must be measured without changing the
complete-graph invariant.

Hardware-GPU results, mobile thermal behavior, maximum texture size, context-loss
recovery time, and production bundle deltas are not measured here. Issue #288 must
record those browser results before cutover. If a supported browser cannot retain
the complete overview, it must use the progressive Canvas fallback or show an
explicit recoverable failure; it must not silently return to a card/edge cap.

## Issue #286 implementation boundary

Issue #286 implements the renderer-neutral part of this decision. A typed pure
core builds deterministic weakly-connected components, BFS placement, and compact
shelf packing from card IDs plus numeric edge arrays. Its cache key excludes
title, body, current-card selection, and camera state. When topology changes, an
exact identity check reuses unaffected component-local geometry; the fingerprint
is only a lookup hint and is never trusted without comparing node and edge
identities.

A Vault/session-scoped controller and browser worker adapter own the asynchronous
lifecycle. Superseding work is cancelled, stale or malformed responses are
rejected, and the last complete layout remains available while a replacement is
in flight. The controller retains at most that ready result and one pending
request. Logout or scope destruction terminates the worker and clears both. The
worker receives card IDs, source/target indexes, and layout configuration only;
card titles and bodies never cross this boundary.

This implementation is not connected to the default connections UI in #286.
Rendering, semantic zoom, spatial detail, camera policy, accessibility, and the
default cutover remain isolated in Issues #287–#290. Reverting #286 therefore
removes the new core/worker path without changing stored content, migrations, or
the current connections behavior.

## Issue #287 routing and spatial-index boundary

Every canonical directed source/target pair is the identity of exactly one
logical route. The stable public route ID is derived from both Card IDs rather
than the edge's array position, so unrelated insertions do not rename a link.
Self-links and both directions of a mutual link remain distinct. No route is
bundled, sampled, ranked, or inferred.

Detail geometry uses deterministic orthogonal cell corridors. Endpoint stubs
leave each node for the half-cell corridor, long vertical and horizontal
segments remain between node rows or columns, and the final stub enters the
target. Mutual directions choose opposite corridors; a self-link uses a compact
loop around its own cell. The node-detail half-width and half-height must remain
strictly smaller than the corresponding half-cell, which makes non-endpoint node
interiors an invariant for the packed layout. A non-self detour is bounded by
the endpoint Manhattan distance plus two cell widths and one cell height.

The dense graph does not retain six point objects per edge. Route points are
materialized only for viewport detail. The immutable index stores four Float32
bounds, one Uint32 sorted edge index, and one Float32 prefix maximum per edge:
24 bytes/edge, or 27,840,000 bytes at the measured 1,160,000-edge envelope.
Its interval query checks actual orthogonal segments after the bounds filter, so
a segment crossing the viewport is returned even when both endpoints are
outside. A viewport containing the aggregate bounds returns all canonical edge
indexes directly. The worst case remains O(E), which is necessary when fit-all
must account for all E edges; the index never changes membership to improve a
query time.

This Issue still does not connect a renderer or alter the default UI. The later
renderer can use straight retained overview vertices for density and materialize
these node-safe routes only for bounded detail, while both layers retain the
same semantic edge identity.

## Issue #288 semantic renderer boundary

The renderer keeps a topology/layout keyed dataset independent from the camera.
Its retained overview geometry is exactly four Float32 coordinates per directed
edge and two per node. An x-sorted node index and an incident-edge index support
bounded detail and current/selected emphasis without placing titles or bodies in
the global geometry. For the representative 10,000/19,951 graph these renderer
arrays total 638,828 bytes: 319,216 edge positions, 80,000 node positions, 40,000
node-index bytes, 40,004 incident offsets, and 159,608 incident edge indexes. For
the quota-derived 10,000/1,160,000 envelope the same formula is 28,000,004 bytes.
The separate 24-byte-per-edge routing index from #287 remains separately reported;
neither number hides graph or edge sampling.

LOD is a pure render-plan decision based on projected node diameter. The default
overview/network hysteresis enters at 3 px and exits at 2 px; network/detail enters
at 24 px and exits at 18 px. A jump may cross two levels directly. The plan keeps
overview node/edge counts equal to the complete dataset at every level, while its
viewport query materializes node-safe routes, card shapes, direction cues and
labels only for Network or Detail. Current and selected nodes and their incident
edges remain a bounded emphasis overlay even in Overview. Reduced-motion changes
the level transition from a crossfade to an immediate cut; it never changes graph
membership.

The browser adapter uses a viewport-sized retained overview canvas plus a
viewport-sized detail canvas. WebGL2 is attempted first. Its position buffers are
uploaded once per geometry key, every edge and node is submitted, and the retained
fit-all raster is moved by a CSS camera transform without a global redraw. Resize,
DPR and theme changes redraw from retained buffers but do not rerun layout or
routing. The adapter checks the actual backing dimensions against
`MAX_TEXTURE_SIZE`, treats context loss as an explicit status, and rebuilds from
the typed dataset after restoration. When WebGL2 is unavailable or Canvas2D is
explicitly selected, the full overview is built in 20,000-item rAF chunks rather
than a synchronous all-edge loop. Camera submissions are latest-wins and share at
most one scheduled frame; only the viewport detail layer is redrawn.

The renderer accepts label/title values only for node indexes already selected by
the current detail plan. It has no `CardRecord`, account, Vault or session payload,
and `dispose()` cancels pending frames, deletes GPU resources, clears both backing
stores and rejects later work. The production composition does not import this
adapter yet, so #288 adds no default application path or production bundle entry;
the scoped connection in #291 must remeasure its bundle effect.

Focused Playwright coverage runs the actual bundled adapter on Desktop Chromium
and Pixel 7 emulation. A deterministic 256-node/20,480-edge graph reaches ready in
both WebGL2 and multi-frame Canvas2D modes, preserves exact ready counts, coalesces
20 camera submissions into one frame/detail draw without another overview draw,
redraws both layers for a theme change, and rebuilds after a synthetic WebGL
context-loss/restoration sequence. These are structural browser checks, not a
wall-clock SLA. The test host still uses Chromium/ANGLE and mobile emulation; real
hardware-GPU throughput, thermal behavior and device-specific driver loss remain
deployment/canary risks rather than claims made by this Issue.

## Rollback

Issues #285–#288 introduce no persistent data or schema migration. Their PRs can
be reverted in reverse dependency order to remove rendering, routing,
layout/worker, and then benchmark/decision artifacts. None is connected to the
default UI yet. The feature remains isolated on
`integration/106-full-network-semantic-zoom`; canonical integration and `main`
are unchanged until their separate roll-up approvals.
