# ADR 004: Native map camera and measured connections routing

- Status: accepted for parent Issue #41
- Date: 2026-09-12
- Decision owners: implementation Issue #43, follow-up research Issue #57, and
  routing implementation Issue #59
- Baseline commit: `7f925fa3b51dc546b32cebbf10550dbd2807560f`

## Context

The connections view needs a large, recoverable map camera and smooth links without
regressing its directed-graph semantics or routing links through cards. An earlier
center-point Bezier experiment in Issue #3 and PR #4 sent curves behind unrelated
cards. Curve presentation therefore cannot substitute for a node-safe route.

The existing implementation uses elkjs 0.12.0 with ELK Layered, `RIGHT`,
`ORTHOGONAL`, and one fixed EAST/WEST port per directed edge. This ADR fixes the
evaluation order and corpus before selecting any alternative. The full generated
measurements are in
[`connections-routing-baseline.json`](../benchmarks/connections-routing-baseline.json)
and the browser measurements are in
[`connections-browser-baseline.json`](../benchmarks/connections-browser-baseline.json).

## Evidence and evaluation method

Candidates are evaluated in this order:

1. zero node intrusions, finite geometry, correct endpoints, continuous sections,
   complete semantic edges, deterministic output, and unmodified inputs;
2. fewer edge crossings;
3. fewer/shorter overlapping center-line segments;
4. shorter total route, fewer bend/control points, and smaller graph area;
5. representative layout median no more than 1.10x baseline and p95 no more than
   1.20x baseline, followed by path/time-to-ready, blocking, bundle, license, and
   maintenance cost.

The fixed corpus contains the reported C→A/C→B/A→B graph, diamond, separate
fan-in and fan-out, cycle, self link, mutual links, disconnected components,
K3,3, and xorshift-generated medium (24 nodes/48 edges, seed `0x41c0ffee`) and
large (48 nodes/120 edges, seed `0x41decade`) graphs. Each layout candidate is run
twice to check determinism and input immutability. Timing uses one warm-up and five
measured cold and warm iterations. Curves are sampled at 12 intervals per segment
for clearance and intersection comparisons. `npm run benchmark:connections`
regenerates the routing artifact; it is deliberately not a timing gate in CI.

ELK's official documentation says SPLINES bend points must be interpreted as
piecewise cubic control points, not polyline vertices, and its default SLOPPY mode
may overlap nodes. The CONSERVATIVE mode routes around nodes at the cost of more
orthogonal-looking results. The benchmark therefore uses CONSERVATIVE and emits
SVG `C` segments from cubic triplets. Sources:
[ELK edge routing](https://eclipse.dev/elk/reference/options/org-eclipse-elk-edgeRouting.html),
[ELK spline mode](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-edgeRouting-splines-mode.html),
[ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html),
[unnecessary bend points](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-unnecessaryBendpoints.html),
[straight-edge preference](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-favorStraightEdges.html),
[straightness priority](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-priority-straightness.html),
[shortness priority](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-priority-shortness.html),
[port constraints](https://eclipse.dev/elk/reference/options/org-eclipse-elk-portConstraints.html), and
[port index](https://eclipse.dev/elk/reference/options/org-eclipse-elk-port-index2.html).
The installed 0.12.0 worker implementation was also inspected to confirm those
option defaults and the cubic-triplet representation actually used by this build.

## Routing results

All four candidates had zero node intrusions, endpoint mismatches, section
discontinuities, non-finite values, and overlapping segments on the fixed corpus.
Aggregate route metrics were:

| Candidate                             | Crossings |          Length | Bends/controls |       Area | Decision                   |
| ------------------------------------- | --------: | --------------: | -------------: | ---------: | -------------------------- |
| ORTHOGONAL + FIXED_SIDE baseline      |       550 |         298,471 |            590 | 22,373,478 | retain route               |
| Same route + safe quadratic corners   |       549 | 295,276 sampled |            590 | 22,373,478 | adopt only as presentation |
| ORTHOGONAL + FIXED_ORDER + priorities |       673 |         303,501 |            564 | 23,683,800 | reject                     |
| SPLINES CONSERVATIVE + FIXED_SIDE     |       559 | 282,294 sampled |          5,890 | 22,272,248 | reject                     |

The small fixtures had zero crossings except K3,3 (baseline 9, rounded 9,
fixed-order 9, spline 7); the fixed-order candidate also introduced one crossing
in both the reported and diamond fixtures. Medium/large crossings were baseline
49/492, rounded 49/491, fixed-order 80/582, and spline 51/501. These fixture-level
results matter more than the one-crossing aggregate difference produced by curve
sampling: rounded corners use exactly the baseline ELK route and are not reported
as a routing improvement.

Large warm-layout median/p95 values in milliseconds were baseline 636.742/670.585,
fixed-order 801.530/812.368, and spline 697.581/727.151. Fixed-order is 1.259x/
1.211x and fails both thresholds. Conservative spline is within the time thresholds
but worsens the primary crossing metric and increases control/sample complexity by
roughly 10x. A supplementary fixed-side priority experiment reduced route points
about 3.4% but did not improve crossings and increased route length and area, so it
also does not qualify. No result is claimed to be a global optimum.

The safe-corner prototype retains the node-safe orthogonal route, removes duplicate
and collinear points, and clamps each quadratic radius to 16 px, half of each
adjacent segment, and half of the configured 44 px edge/node clearance. Its large
path generation median/p95 was 0.218/0.268 ms in the research run and is linear in
total route points. Issue #46 reuses the same production function in the benchmark
and adds actual SVG endpoint, arrow tangent, section continuity, self/mutual link,
short/duplicate/collinear segment, and sampled clearance contracts.

## Post-deployment routing follow-up

Issue #57 reruns routing research from checkpoint
`checkpoint/pre-review-fixes-a012ec9` without changing the production default.
The generated fixture-by-fixture values and all timing samples are in
[`connections-routing-follow-up.json`](../benchmarks/connections-routing-follow-up.json).
The evaluation keeps the previously defined large seeded graph (48 nodes/120
edges, seed `0x41decade`) as the representative performance fixture; the medium
seed is retained as a diagnostic. One warm-up and five measured samples are kept
verbatim, with no outlier removed. Timings are evidence rather than a CI gate.

The observed long reverse route is a constraint result, not a renderer defect.
The production ELK input creates a distinct port for every semantic endpoint,
sets every source port to EAST and every target port to WEST, applies
`FIXED_SIDE` to every node, and lays layers toward `RIGHT`. Cycle breaking may
reverse an edge for layering, but it cannot change either fixed endpoint side;
the returned orthogonal edge section therefore has to leave and re-enter around
the node exterior. The SVG layer consumes that section and does not choose the
route.

ELK Layered documents orthogonal routing and arbitrary port constraints. `FREE`
leaves port placement to the layout algorithm; `FIXED_SIDE` fixes only the side;
`FIXED_ORDER` additionally depends on each port's index. The follow-up therefore
tests the installed elkjs 0.12.0 behavior rather than assuming that “four ports”
alone changes routing. Sources:
[ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html),
[port constraints](https://eclipse.dev/elk/reference/options/org-eclipse-elk-portConstraints.html),
[port index](https://eclipse.dev/elk/reference/options/org-eclipse-elk-port-index2.html),
and [edge routing](https://eclipse.dev/elk/reference/options/org-eclipse-elk-edgeRouting.html).

All aggregate values below cover 16 fixtures, including the earlier corpus plus
horizontal/vertical/diagonal mutual pressure, a bidirectional five-node cycle,
an obstacle-near reverse edge, and both deterministic seeds. “Hard” is the count
with zero semantic, endpoint/side/tangent/section, degeneracy, node/halo,
indistinguishable-mutual, and finite errors; every candidate is also deterministic
and leaves its input byte-for-byte unchanged.

| Candidate                                   |  Hard | Total length | Mutual excess | Crossings | Overlap segments | Bends/controls |           Area | Decision                        |
| ------------------------------------------- | ----: | -----------: | ------------: | --------: | ---------------: | -------------: | -------------: | ------------------------------- |
| ORTHOGONAL + FIXED_SIDE + EAST/WEST         | 16/16 |      315,097 |        10,828 |       555 |                0 |            656 |     24,416,772 | baseline                        |
| ORTHOGONAL + FREE, ELK side choice          | 16/16 |  264,627.667 |           806 |       407 |                0 |            586 |     24,136,576 | adopt in a separate Issue       |
| Relative side + FIXED_SIDE, two ELK passes  | 16/16 |  275,646.667 |         1,056 |       461 |                0 |            615 |     23,864,702 | reject: performance             |
| Relative side + FIXED_ORDER, two ELK passes | 16/16 |      283,334 |         2,134 |       681 |                0 |            607 |     25,149,156 | reject: performance/crossings   |
| Relative side + visibility post-route       | 11/16 |      269,461 |            72 |       496 |              781 |            617 |     24,416,772 | reject: hard/performance        |
| CONSERVATIVE SPLINES + FIXED_SIDE           | 15/16 |  297,679.223 |     8,708.814 |       566 |                0 |          6,436 | 24,315,542.222 | reject: self tangent/complexity |

The FREE candidate cuts aggregate route length by 16.0%, mutual reverse excess
by 92.6%, crossings by 26.7%, and bends by 10.7%. It makes the two-node mutual
route 296 px rather than 1,184 px, reduces the five-node bidirectional fixture
from 7,688 px/2,120 px excess to 3,094 px/18 px, and leaves reported, diamond,
fan, disconnected, and K3,3 fixtures unchanged. Its large-graph area grows 5.1%
even though aggregate area falls 1.1%; that lower-priority regression is retained
in the artifact rather than hidden.

On the representative large fixture, FREE cold median/p95 ratios are
0.917x/0.896x and warm ratios are 0.960x/0.897x, satisfying 1.10x/1.20x. Its
medium cold ratios are 0.886x/0.925x; one non-interleaved warm batch trends upward
to 1.140x/1.118x and is retained as host/runtime variability. Large path creation
is 0.164/0.330 ms versus baseline 0.081/0.141 ms, still below one millisecond.
Production continues to execute ELK in the existing worker, so these Node
single-call samples are not main-thread blocking measurements and camera events
do not invoke either layout or path generation.

The visibility prototype explicitly uses inflated node rectangles as obstacles
and a deterministic rectilinear shortest-path graph. It demonstrates where
post-routing can reduce length, but makes reverse pairs indistinguishable in five
fixtures, creates 781 overlapping segment pairs, and takes 2.79x/2.51x the
baseline large warm median/p95. A production version would also require a second
route phase, new worker work, cache-version/config inputs, and overlap/lane
allocation. The two-pass relative candidates have a position/side feedback loop:
the first layout chooses positions, the derived sides cause a second layout to
choose new positions, and no fixed point is guaranteed. They cost 1.70x–6.33x on
the representative large warm measurements. These approaches remain future
options only if lane separation and bounded incremental routing are designed and
remeasured.

No candidate adds a package. Research-only relative and visibility functions are
excluded from the application graph. The production decoding seam adds 855 raw /
284 gzip bytes to the application chunk at the Issue #57 branch point; CSS and
the 1,595,334 raw / 464,634 gzip ELK worker are byte-identical. elkjs retains its
existing `EPL-2.0 OR GPL-3.0-or-later` declaration. The adopted configuration uses
the same single offline worker and cache lifecycle; changing its default creates
a normally versioned worker asset without a network runtime dependency.

Issue #59 applies that recommendation as the production default: ORTHOGONAL,
`FREE`, and no per-port side hint. The boundary infers and validates the actual
N/E/S/W side from each returned ELK port before geometry enters the application.
Ambiguous combinations such as FREE with fixed side hints, or a fixed policy with
ELK-selected sides, fail at the layout boundary. The fixed-side configuration
remains explicit only as a benchmark baseline.

The production-default unit run repeats all 16 hard-constraint fixtures and pins
the two-node mutual total at 296 px and the bidirectional five-node total/excess
at 3,094/18 px. Three offline-worker browser runs gave desktop initial
920.1/924.4 ms median/p95 and cached re-entry 127.9/128.6 ms; Pixel 7-equivalent
mobile gave 917.5/921.9 ms and 120.3/126.0 ms. All recorded frame gaps are at most
16.8 ms and Chromium reported no long task. The default switch adds 95 raw / 40
gzip application bytes against the Issue #59 branch point; CSS and the ELK worker
are byte-identical and no dependency is added. Full production evidence is in
[`connections-routing-production.json`](../benchmarks/connections-routing-production.json).

## Camera decision

Use typed pure camera functions plus a small browser hook built on Pointer Events,
CSS transforms, ResizeObserver, and requestAnimationFrame. Do not add a pan/zoom
runtime dependency. One transformed world wrapper can satisfy the exact capture,
cancel/lost-capture, drag-click suppression, keyboard, focus recovery, fit/current,
wheel policy, and reduced-motion contracts while keeping React out of raw move
events. Pointer Events explicitly define `touch-action`, pointer cancellation, and
capture behavior; CSS transforms establish the camera coordinate system.
Sources: [W3C Pointer Events](https://www.w3.org/TR/pointerevents/) and
[CSS Transforms](https://www.w3.org/TR/css-transforms-1/).

The post-deployment follow-up keeps that architecture and fixes a target-identity
error in the capture cleanup. Touch starts with implicit capture on the hit-tested
node/canvas descendant. At the 6 px drag threshold, explicit capture moves to the
viewport and the descendant emits a bubbling `lostpointercapture`. Treating that
bubbled event as if the viewport itself had lost capture removed the only active
pointer, which explains the observed short shift followed by stopped one-finger
pan. The adapter now ignores descendant-targeted loss while retaining cleanup for
viewport-targeted loss, `pointercancel`, and window `pointerup`. Capture is not
moved on `pointerdown`, so a sub-threshold node tap retains its click target.

The same follow-up fixes every camera operation to 0.10–2.00 scale. A pure camera
projection produces both the rounded 10–200% output and epsilon-stable boundary
booleans; the rAF adapter applies these to native zoom-button `disabled`
properties in the same camera commit. The three-run Pixel 7/Desktop Chrome trace,
timing, bounds, and +536 raw/+148 gzip application-chunk delta are recorded in
[`connections-camera-follow-up.json`](../benchmarks/connections-camera-follow-up.json).
There is no CSS, ELK worker, offline-cache, or dependency delta.

Issue #70 retains a user's explicit zoom scale across presentation-view unmounts
and reloads as one versioned device-local preference. The boundary adapter treats
the stored value as untrusted, and the pure camera core clamps it to 0.10–2.00
before restoring it against current geometry. It deliberately does not persist
camera translation, layout results, or current-card identity: those values can be
stale after graph, viewport, or navigation changes. Gesture writes are debounced
and pending scale is flushed at unmount, so raw pointer moves still only update
the rAF-coalesced world transform and never synchronously write storage per move.

[Panzoom 4.6.2](https://github.com/timmywil/panzoom) was the external comparison.
It is MIT-licensed, uses Pointer Events/CSS transforms/requestAnimationFrame, and
advertises about 3.7 kB gzip. Its published 4.6.2 package was 161,576 unpacked
bytes when inspected. It would not remove this product's custom world clamping,
fit/current/focus recovery, wheel ownership, click suppression, accessibility,
or lifecycle work, so the extra abstraction and dependency have no measured
benefit here.

## Performance and bundle baseline

On Playwright Chromium with the 48-node/120-edge fixture, five offline runs gave:

| Project | Initial ready median/p95 | Re-entry median/p95 | Initial max-frame-gap median/p95 | Re-entry gap median/p95 |
| ------- | -----------------------: | ------------------: | -------------------------------: | ----------------------: |
| desktop |           876.9/948.2 ms |      818.1/900.5 ms |                   716.7/783.3 ms |          649.9/716.7 ms |
| mobile  |           935.0/973.6 ms |      904.5/939.5 ms |                   749.9/799.9 ms |          716.7/733.3 ms |

Chromium reported no Long Tasks entries, but the synchronized frame-gap monitor
shows a 600–800 ms main-thread stall, so zero Long Tasks is not treated as zero
blocking. Issue #45 must compare an offline-bundled ELK worker or a bounded cache
before accepting more layout complexity. Camera gestures must never trigger layout
and must independently meet the 8 ms p95 / no >50 ms long-task acceptance target.

The baseline application chunk was 1,927,985 bytes raw / 592,384 gzip and CSS was
45,931 / 8,420. The benchmark seam and fixture E2E measurement produce
1,928,977 / 592,718 and CSS 45,961 / 8,426: +992 raw / +334 gzip JavaScript and
+30 / +6 CSS, with no new runtime package. This is a research-branch measurement,
not a promise about the later UI bundle.

Issue #45 retained the exact selected route and moved the installed ELK worker
behind a browser adapter. The worker's hashed build asset is cached before the
application reports offline readiness and is prewarmed without performing a
layout. A four-entry least-recently-used cache shares in-flight and settled
layouts across controller re-entry; graph or layout-metric changes still create a
new key, and rejected work is evicted for retry. The full five-run comparison is
in
[`connections-worker-cache.json`](../benchmarks/connections-worker-cache.json).

For the same offline 48-node/120-edge fixture, desktop/mobile initial ready median
ratios were 1.046x/0.978x baseline, inside the predefined 1.10x bound, while p95
ratios were 0.971x/0.940x. Initial maximum frame-gap medians fell from
716.7/749.9 ms to 16.8/16.8 ms. Cached re-entry ready medians fell from
818.1/904.5 ms to 131.3/127.1 ms. The render-critical application chunk fell by
436,697 gzip bytes; the separately cached existing ELK worker makes combined
transfer 27,937 gzip bytes larger. This is accepted because it removes the
measured blocking without a new dependency or route change and retains offline
operation.

## Curve implementation and final evidence

Issue #46 implements the selected presentation as a typed pure route-to-SVG core.
Stack normalization removes only duplicates and forward-collinear points, thereby
preserving a collinear U-turn. Each non-collinear corner emits a real quadratic
`Q`; its radius is clamped by the presentation maximum, half of both adjacent
segments, and half of the configured edge/node clearance. The first and last
points are unchanged and a final straight segment preserves the marker tangent.
The renderer retains the 8 px card-color halo and marker only on the final section.
Its memo comparator keys geometry on the controller's graph-and-metrics layout key
plus both curve settings, so semantic label updates remain outside the SVG while
pan/zoom never regenerates paths.

The regenerated fixed corpus remains at zero node intrusions, endpoint mismatches,
section discontinuities, and non-finite values. All aggregate quality values are
identical to the research safe-rounded candidate: 549 sampled crossings,
295,276.332 sampled route length, 590 bends/controls, and 22,373,478 area. The
48-node/120-edge production path function measured 0.300 ms median / 0.426 ms p95.
Contemporaneous cached re-entry comparisons were 1.071/0.996 desktop and
1.031/1.016 mobile for median/p95, within the 1.10/1.20 curve-only bounds. Initial
worker timing on the shared host was non-stationary; the unchanged layout runtime's
stable accepted measurement remains the Issue #45 result, and both the diagnostic
and consecutive batches are retained rather than hidden. The application/combined
JavaScript delta against a same-host branch-point build is +2,375 raw / +810 gzip
bytes; the worker is byte-identical and there is no new runtime dependency.

Full values and their attribution limits are in
[`connections-curve-final.json`](../benchmarks/connections-curve-final.json).
Desktop/mobile × light/dark visual evidence and its review checklist are in
[`screenshots/connections-map`](../screenshots/connections-map/README.md).

## 10,000-card staging addendum

Issue #266 applies the approved large-Vault product decision: connections no
longer sends every card to ELK when a Vault exceeds the small-graph bound. A
typed pure selector treats incoming and outgoing links as neighborhood
adjacency while retaining the original directed edges for rendering. It starts
from the current card, sends at most 64 nodes to the worker, and expands in
64-node pages to a hard maximum of 256 nodes. Issue #275 removes the
connections-only search UI and its query logic to preserve the paper
Zettelkasten product direction. The current card is now always the staging
root. Reaching the maximum directs the user to open another card before viewing
its neighborhood rather than silently laying out the rest of the Vault.

Graphs with at most 64 cards retain the existing all-card behavior, including
isolated and disconnected cards. The full local replica remains available for
offline editing; staging changes only layout and DOM membership. The
selector has no DOM, worker, clock, network, or storage dependency, and the
React adapter passes only its bounded result to the existing renderer-neutral
layout controller. Fixed-count unit and 10,000-card browser assertions are the
required structural gate; wall-clock timings remain observational.

## Consequences

- The original study retained ORTHOGONAL + FIXED_SIDE. The expanded Issue #57
  corpus superseded that choice, and Issue #59 now uses ORTHOGONAL + FREE with ELK
  side selection as the production default.
- Implement native pan/zoom in Issue #44 with one CSS transform and pure camera
  geometry; ELK is not rerun by camera changes.
- Investigate worker/cache evidence in Issue #45 while preserving the selected
  route and all graph semantics. The measured worker plus bounded cache is now the
  accepted ELK runtime adapter.
- Use the Issue #46 safe SVG quadratic rounding as presentation over the retained
  route. It smooths corners but is not labeled a routing improvement.
- Keep the benchmark artifact and fixed fixtures as reproducible compatibility
  evidence. Raw timing remains informational rather than a flaky CI threshold.
- Preserve the 64/64/256 staging policy unless a later reviewed Issue changes
  both the structural worker/DOM bounds and the user-visible navigation path.
