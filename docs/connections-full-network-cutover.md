# Connections full-network UI cutover (Issue #311)

## Decision and scope

Issue #311 removes the product 64/64/256 neighborhood staging layer. The
adapter now passes the active provider's complete semantic graph to the hybrid
layout manager, and changing the selected card no longer remounts the adapter.
The engine boundary at 256 nodes / 1,024 directed edges remains a calculation
policy only; it does not filter graph membership.

The existing provider, Sync v2 paging, tombstone, offline-replica, and scope
boundaries are unchanged. “Complete” still means the visible replica owned by
one active permitted scope, not a cross-account or cross-Vault union.

## Camera and retained semantics

Camera limits are derived from the measured viewport and the union of layout,
node, route, halo, and marker bounds. The minimum is
`min(0.1, rawFitScale / 2)`, while the maximum remains 2 and fit never enlarges
beyond 1. Stored zoom values are decoded as finite positive numbers before the
current geometry applies its limits, so the existing v1 storage key now round-
trips valid values below 0.1. Small percentages retain significant digits and
never display as `0%`.

Every card keeps one lightweight button shell in original logical order. A
focused/current or viewport-visible card mounts its visual children. Every
directed relationship remains in the semantic list. Focusing an off-screen
button moves the camera and mounts its visual content before interaction; no
keyboard range is trapped or truncated.

## Visual visibility index

The pure visibility core prepares the existing quadratic path once per layout
geometry reference. It indexes node bounds and every line/quadratic segment in
a static median-split BVH. Quadratic bounds include start, control, and end;
route bounds conservatively include the 8 px halo and the 14-world-unit SVG
marker extent. A 96-screen-pixel overscan query is converted to world space.
An edge is drawn when any of its segments intersects that query, even when both
endpoint cards are outside it. Results are restored to original edge order, so
halo overlap order remains stable.

Camera movement uses the existing rAF transform path. A visibility query may
run on a camera commit, but React state changes only when the ordered node/edge
index sets change. Pan, zoom, selection, title, and non-link body changes do not
rerun layout or recreate paths. A topology/policy change receives a new layout
key; a surviving current card retains its screen anchor when constraints allow.

## Product-browser evidence

The saved single-run observations use Chromium 153.0.8010.12 and the existing
10,000-card browser fixture after its 48 intentionally missing link targets are
rebound by the test adapter. The graph contains 10,000 nodes and 19,999 valid
directed edges. These are diagnostic samples, not statistical SLO evidence.

| Project          | Viewport / DPR  | Initial ready | Fit scale | Localized focus |  Re-entry |
| ---------------- | --------------- | ------------: | --------: | --------------: | --------: |
| desktop Chromium | 1280×720 / 1    |     12,763 ms |   0.3513% |        1,696 ms | 19,619 ms |
| mobile Chromium  | 412×839 / 2.625 |      7,944 ms |   0.3537% |        1,551 ms | 15,654 ms |

At localized scale, desktop retained all 10,000 button shells and 19,999
semantic relation items while mounting visual content for one card and 195 SVG
paths; mobile mounted one visual card and 97 paths. At whole-world fit, every
edge intersects the viewport, producing 39,999 SVG path elements and about
130,002 graph descendants. The complete raw observation is in
[`connections-full-network-ui.json`](benchmarks/connections-full-network-ui.json).

The UI cutover therefore proves complete membership, whole-world reachability,
sub-10% camera support, and safe localized culling. It does **not** meet the
provisional 10k five-second product target. The Worker geometry measurement from
Issue #318 was below 0.5 seconds, while whole-world SVG/React/paint dominates
this run. Per the approved decision boundary, the next independent Issue must
evaluate the specified Canvas 2D edge layer. The card HTML, complete semantic
list, camera, toolbar, layout output, curve segments, halo/stroke/arrow order,
and accessibility contracts remain unchanged. WebGL and card Canvas rendering
are not authorized by this result.

`main`, deployment, Sites, and production data are unchanged.
