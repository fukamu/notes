# 10,000-card client performance benchmark

Issue #200 establishes a synthetic, repeatable baseline for the 10,000-card
Personal Vault limit. It is measurement infrastructure, not a production data
migration or a decision to render all 10,000 cards in the connections view.

Run the focused benchmark from a clean worktree:

```bash
npm run benchmark:client
```

The command writes
`docs/benchmarks/10k-client-baseline.json`. The artifact records the exact
fixture configuration, branch point, runtime/host metadata, raw samples,
median, nearest-rank p95, observational heap values, and stable serialized-byte
proxies. It uses generated content only and performs no network, D1, R2, KMS,
Stripe, or production operation.

## What is measured

- deterministic fixture construction;
- JSON parse plus the existing `CardRecord` boundary decoder as an initial
  local-replica load proxy;
- card-editor labels and link-candidate input construction;
- one numeric-prefix candidate interaction;
- history ordering and linked-card preview construction;
- the typed connections graph-input boundary, without ELK layout or a
  full-graph UX commitment.

Browser DOM, paint, long-task, scrolling, and retained-heap evidence belongs to
the final #204 browser benchmark. The Node heap deltas in this baseline are
observations only because garbage collection and unrelated host load make them
unsuitable for a strict CI threshold.

## Budgets and comparison policy

The stable scale limits are enforced directly: 10,000 active cards, at most
1,000 fixture text characters per card, at most 8 KiB serialized content per
card, and at most 128 MiB for the serialized fixture replica. These correspond
to the product quota and recommended internal envelope.

Issue #200 deliberately adds no unexplained absolute wall-clock gate. A
follow-up PR must run the same case on the same host and retain all samples.
For a non-targeted phase, review tolerance is the larger of 20 percent or three
times that baseline's median-to-p95 spread. Targeted phases must improve in the
expected direction and satisfy their hardware-independent mechanism budget:

- #201: zero history/connections selector calls while editing a card;
- #202: no full candidate sort for each typed prefix;
- #203: one card-label lookup build per history selection, not per item;
- #204: mounted history rows bounded by viewport plus fixed overscan.

These mechanism checks are the required regression gates. Timing remains
evidence until #204 records browser before/after results and can justify a
user-facing threshold. This avoids converting normal CI host variance into a
new, self-imposed completion blocker.

## Issue #200 baseline

The committed 2026-09-14 reference-host run measured:

| Boundary                       |       Median |          p95 |
| ------------------------------ | -----------: | -----------: |
| Fixture generation             |    15.981 ms |    20.067 ms |
| Serialized replica decode      |    80.249 ms |    83.110 ms |
| Card-editor input model        |     1.988 ms |     4.413 ms |
| Link prefix interaction (`99`) |     0.194 ms |     0.338 ms |
| History view model             | 5,404.852 ms | 5,424.005 ms |
| Connections input boundary     |    15.272 ms |    16.709 ms |

The fixture occupies 26,777,301 serialized bytes, its largest serialized card
content is 2,517 bytes, and its largest resolved title/body display is 854
characters. The roughly 5.4-second history selector is the concrete baseline
for #203; it is not a newly accepted user-facing limit. The artifact remains
the source of truth for raw samples and host metadata.

## Issue #201 demand-driven projection

`docs/benchmarks/10k-demand-driven-presentation.json` compares the previous
eager card-view work with the discriminated active-view model on the same
fixture and host:

| Projection                     |       Median |          p95 |
| ------------------------------ | -----------: | -----------: |
| Previous eager card-view proxy | 5,311.330 ms | 5,311.330 ms |
| Demand-driven card             |     1.865 ms |     3.575 ms |
| Demand-driven history          | 5,384.287 ms | 5,384.287 ms |
| Demand-driven connections      |    11.334 ms |    11.882 ms |

The observed card-view median ratio is 2,847.898×. That ratio is evidence, not
a timing assertion: the stable gate is that the `card` model cannot contain a
history or connections projection, while the other two variants materialize
only their selected projection. History itself remains intentionally unchanged
and is still the target of #203.

## Issue #202 link-candidate index

`docs/benchmarks/10k-link-candidate-index.json` compares the previous
per-interaction replica scan/sort with the pure prefix index on the same
10,000-card fixture and host:

| Boundary                        |    Median |       p95 |
| ------------------------------- | --------: | --------: |
| Previous four-prefix scan/sort  |  3.153 ms |  3.333 ms |
| Candidate index rebuild         | 10.432 ms | 10.889 ms |
| Four indexed prefix lookups     |  0.001 ms |  0.001 ms |
| Body-only 10,000-card reconcile |  0.394 ms |  0.403 ms |

The rebuild is intentionally paid when candidate-visible metadata or ordering
changes. Body, update-time, and revision-only edits reuse the same index
identity, so ordinary editor input performs the reconcile scan without a
candidate sort or prefix-bucket rebuild. Prefix interaction itself is one
`ReadonlyMap` lookup and does not scan the card replica.

Focused compatibility tests compare all indexed results with the existing
`linkCandidates` implementation for empty, matching, missing, ASCII-invalid,
duplicate-number, provisional, and stable-tie cases. The optimization does not
alter IME, keyboard selection, link insertion, current-card exclusion, or label
formatting. Results are bounded at 9,999—the 10,000 active-card product limit
minus the excluded current card—without adding a smaller UI cap. As with the
earlier benchmark, timings are review evidence rather than absolute CI gates;
exact output equivalence, body-only index reuse, and the lookup mechanism are
the stable gates.

## Issue #203 history preview lookup

`docs/benchmarks/10k-history-preview-index.json` compares the legacy
per-history-item all-card `Map` construction with one pure lookup shared by the
selector invocation:

| Boundary                         |       Median |          p95 |
| -------------------------------- | -----------: | -----------: |
| Previous per-item lookup rebuild | 5,390.062 ms | 5,390.062 ms |
| Indexed single-lookup history    |    36.277 ms |    42.604 ms |

The reference-host median improved by about 148.6×. Timing remains evidence,
not an absolute CI threshold. The stable computation gate is one lookup build,
at most one entry per distinct `CardId`, one output item per card, and
O(cards log cards + total body segments) time. The stable memory gate is
O(cards) derived lookup space; raw Node heap deltas remain observational
because garbage collection and host load are nondeterministic.

The benchmark asserts all 10,000 output items are exactly equal to the previous
selector. Focused tests additionally preserve display-ID ordering and all tie
breaks, current markers, whitespace normalization, empty-body text,
official/provisional and `Untitled` link labels, missing-link fallback, the
legacy last-card-wins duplicate-ID rule, conflict choices, and caller input
immutability. The lookup exists only within one pure history or conflict
batch-selector call and is never cached across Vault/session/logout boundaries.

## Known boundary

The original baseline measures connections input construction only. Issue #266
selected progressive disclosure around the current card with fixed worker/DOM
bounds, and Issue #275 removed the connections-only search path. Issue #311 has
now superseded those product display bounds: the complete active-scope graph is
sent to the hybrid layout manager, while 256 remains only an engine-selection
boundary.

Issue #305 reopens that product decision under parent #304 without changing the
current renderer. Its exact Node 22.13.0 A/B evidence is documented in
[`connections-full-network-phase-0.md`](connections-full-network-phase-0.md).
The pre-staging 10k semantic input remains roughly 14.6 ms median, but the
existing production ELK configuration fails before warm-up at 1,000 nodes /
3,000 edges and at both 10k cases with a recursive stack overflow. Consequently
the 10k staged browser values remain an A baseline, not evidence that the full
network can be laid out or painted. That finding did not select culling,
spatial indexing, cache weighting, or lower ELK thoroughness by itself. Issues
#316 and #318 subsequently produced complete 10k corridor geometry through the
product Worker manager.

Issue #311 adds whole-world camera limits and conservative segment-BVH culling.
The complete 10k browser run retained 10,000 button shells and 19,999 semantic
links. Localized rendering fell to 195 desktop / 97 mobile SVG paths, but full
fit required 39,999 SVG paths and about 130,002 graph descendants. Initial ready
was about 12.8 s desktop and 7.9 s mobile, outside the provisional five-second
target. The values and attribution limits are in
[`connections-full-network-cutover.md`](connections-full-network-cutover.md).
That measured SVG/full-fit bottleneck activates only the approved Canvas 2D edge
evaluation; it does not justify reducing graph membership or accessibility.

Issue #321 performs that bounded evaluation without changing graph membership,
card HTML, camera, or the full semantic relationship list. Whole-world SVG edge
paths fall from 39,999 to zero and graph descendants from about 130,002 to
50,003, with one viewport×DPR canvas. Localized Canvas drawing is 0.3 ms in the
recorded desktop and mobile samples. Whole-world Canvas drawing is 73.6 ms and
115.1 ms, however, and complete readiness remains 11.2 s and 21.0 s. The edge
renderer therefore does not satisfy the provisional 5 s / 50 ms product
targets. Details and attribution limits are in
[`connections-canvas-edge-layer.md`](connections-canvas-edge-layer.md). The
result triggers the specified stop boundary rather than a silent semantic cap
or an unreviewed card/semantic virtualization change.

Issue #323 applies the subsequently authorized accessibility-preserving semantic
DOM change. The complete 19,999 directed relations and 10,000 cards remain
searchable through two native lists, but closed list content is unmounted and
each open list renders at most 50 items. In its single desktop/mobile product
samples, closed semantic list items are zero, localized graph descendants fall
from about 30,005 to 10,005, and whole-world descendants from about 50,003 to
30,003. Initial ready was about 6.49–8.66 s desktop and 6.65–8.37 s mobile
across the focused and full-verify samples. This is a
material reduction but still not the five-second result; the remaining complete
card shells and whole-world card content select the separately reviewed card
window/overview Canvas step. See
[`connections-semantic-lists.md`](connections-semantic-lists.md).

Issue #325 removes the remaining always-mounted card DOM. Readable scales mount
only camera/overscan cards plus a retained focused card; overview scales draw
individual card shapes on a viewport Canvas and use the existing node BVH for
card hit testing. The full searchable native lists remain the accessibility and
keyboard path, so this does not reduce the 10,000-node / 19,999-edge semantic
graph. Recorded complete initial readiness is about 3.48 s desktop and 2.54 s
mobile emulation, inside the provisional five-second target. Localized graph
DOM is seven descendants with one card button, and whole-world fit is three
descendants with no card buttons and two canvases.

Continuous 10k whole-world movement still misses the provisional 50 ms target:
frame p95 is about 183 ms desktop and 217 ms mobile, while edge redraw p95 is
about 91/106 ms and overview-card drawing about 4 ms. This identifies repeated
whole-world edge repaint as the remaining measured bottleneck and selects the
bounded viewport bitmap-reuse Issue. `layoutReadyWallMs` remains product
navigation wall time, not an isolated Worker timing. Raw values and limits are
in [`connections-card-windowing.md`](connections-card-windowing.md).

Issue #327 implements the selected bounded bitmap reuse without creating a
world-sized Canvas or tile cache. The overview edge and card layers retain at
most front/back surfaces sized to the graph viewport plus 96 px overscan at the
current DPR. Compatible pan frames copy the capture at the camera delta; zoom
settles to an exact current-scale raster. Direct Canvas drawing remains the
normal-scale path and the synchronous fallback for a failed refresh.

In two product runs per desktop/mobile project, complete 10k readiness remained
about 2.30–2.42 s. Thirty-frame whole-world pan p95 was 33.3–33.4 ms desktop and
33.4 ms mobile emulation; every measured edge/card frame was a reuse, with no
refresh or long task. The representative normal-scale gesture remained 16.7 ms
p95. Cold complete-edge raster remained approximately 77–111 ms and whole-fit
switch wall time approximately 255–286 ms, and both are reported separately.
Because the recorded 5 s, 33 ms normal-operation and 50 ms continuous-fit
targets are met, the conditional OffscreenCanvas Worker is not implemented.
Environment, raw samples and limitations are in
[`connections-bounded-raster-cache.md`](connections-bounded-raster-cache.md).

## Issue #204 browser windowing

`docs/benchmarks/10k-browser-final.json` records three desktop Chromium and
three Pixel 7-equivalent runs of the deterministic 10,000-card fixture. The
browser loads the replica, opens history at its midpoint, scrolls to the final
row, moves keyboard focus with Home/End across unmounted ranges, restores the
history URL with Back, and queries the `99` link prefix. The existing v1
snapshot contract rejects links to cards absent from the response, so the 48
deliberately missing fixture targets are rebound to fixture card 1 only in this
browser adapter. The benchmark remains synthetic and does not contact a
production backend.

History rows use a 108 px fixed height, 12 px gap, 12 px content inset, and four
overscan rows on each side. Both projects mounted 13 rows against a calculated
limit of 14; total history DOM was 205 elements rather than 10,000 card rows.
This viewport-derived bound is the stable CI gate. The reference-host medians
were about 1.05 s for initial load, 105–124 ms to open history, 20 ms to scroll,
and 273–277 ms to expose the 111 matching link candidates. Those timings and
the coarse `performance.memory` samples are retained as evidence, not converted
into an unexplained absolute wall-clock gate.

The range, total height, offset, centering, and keyboard target decisions are
typed pure functions. React owns only DOM measurement, `ResizeObserver`, scroll
events, element refs, and focus. The derived range and refs disappear on
unmount, so no history content cache crosses a provider, Vault, session, or
logout boundary. Existing desktop/mobile URL, Back, card-open, current marker,
list semantics, and keyboard behavior are covered in the same E2E.

That historical Issue #204 browser run intentionally did not activate a
10,000-node connections graph. Demand-driven presentation still proves that
card/history views do not build it. The complete connections view is now covered
separately by the Issue #311 cutover evidence above.
