# Connections Canvas edge layer (Issue #321)

## Decision and boundary

Issue #321 applies the conditional renderer branch selected by the Issue #311
product measurement. The complete layout geometry, card HTML, camera, toolbar,
button shells, and semantic relationship list are unchanged. Only the visual
edge layer moves from per-section SVG elements to one viewport-sized Canvas 2D
surface.

The canvas backing store is the measured viewport multiplied by device pixel
ratio. It is not the roughly 80k×120k corridor world. The same camera snapshot
that updates the HTML world transform is applied once to the Canvas context, so
the transform is not doubled. The existing segment BVH still selects visible
edges in input order, including a route that crosses the viewport while both
endpoint cards are outside it.

`Path2D` objects are prepared once for each layout geometry and retained by the
mounted browser adapter. A camera change clears the viewport surface and draws
each selected edge in its original order: 8-world-unit card-colour halo,
2-world-unit primary stroke at 0.72 opacity, then an opaque terminal arrow. The
arrow pure core reproduces the former SVG marker's 14-world-unit dimensions and
terminal tangent. Theme changes invalidate colours and repaint without changing
geometry. The canvas is pointer-inert and `aria-hidden`; the complete semantic
list remains the assistive representation.

## Verification and visual result

Focused pure tests cover line and quadratic terminal tangents, exact former
marker dimensions, collapsed-tangent rejection, conservative visibility, and
architecture boundaries. Product E2E checks that the canvas contains painted
pixels, has a viewport×DPR backing store, contains no visual SVG edge paths, and
retains all 10,000 card buttons and 19,999 semantic relations. Existing desktop
and mobile gesture scenarios still report 120 camera transform writes over
about two seconds, handler p95 of 0.1–0.2 ms, and no long task.

The recorded localized screenshots show the same rounded orthogonal corridors,
card-colour halo, opaque arrowheads, and card avoidance on desktop and mobile.
At the approximately 0.35% whole-world fit, strokes and card contents are
sub-pixel and therefore faint; whole-world text readability was not a product
requirement. Normal-scale navigation to the current card remains the visual
quality check.

## Product-browser evidence

The saved observations use Chromium 153.0.8010.12 and the same complete
10,000-node / 19,999-directed-edge fixture as Issue #311. They are single runs
on a shared host, not statistical SLO evidence.

| Project          | Viewport / DPR  | Ready through complete semantic/Canvas state | Path2D prepare | Initial Canvas draw | Local draw | Full-fit Canvas draw | Full-fit operation |
| ---------------- | --------------- | -------------------------------------------: | -------------: | ------------------: | ---------: | -------------------: | -----------------: |
| desktop Chromium | 1280×720 / 1    |                                    11,194 ms |        41.2 ms |             77.7 ms |     0.3 ms |              73.6 ms |           3,333 ms |
| mobile Chromium  | 412×839 / 2.625 |                                    20,965 ms |        52.6 ms |            153.1 ms |     0.3 ms |             115.1 ms |           3,950 ms |

The visual graph DOM falls from Issue #311's approximately 130,002 descendants
and 39,999 SVG paths to 50,003 descendants, no SVG edge paths, and one canvas at
whole-world fit. The localized graph has about 30,005 descendants and still
retains 10,000 button shells plus 19,999 semantic list items. The observed heap
samples are 239 MB desktop and 254 MB mobile versus 322 MB and 286 MB in the
committed Issue #311 artifact; heap values remain coarse and GC-dependent.

## Result and remaining blocker

Canvas materially reduces DOM and memory and keeps localized drawing below one
millisecond, but it does **not** satisfy the provisional performance targets.
Full-fit Canvas drawing alone is 73.6–115.1 ms rather than 50 ms, and the full
fit operation remains 3.3–4.0 seconds while React mounts every visible card's
children. Complete initial readiness is 11.2–21.0 seconds in these runs rather
than five seconds. The complete card-button and relationship semantic DOM, and
whole-world card content commit, now dominate beyond the Worker and Path2D
preparation boundaries.

This is the prompt's explicit stop condition: edge Canvas does not by itself
make the complete product UI meet the provisional budget. The implementation
does not hide nodes or edges, remove semantic access, add a silent cap, or claim
10k performance completion. Further work would require a separately reviewed
equivalent-access semantic/windowing or card-detail strategy, or a revised
budget. WebGL, card Canvas rendering, and graph aggregation remain unselected.

The complete raw observation is in
[`connections-canvas-edge-layer.json`](benchmarks/connections-canvas-edge-layer.json).
`main`, deployment, Sites, and production data are unchanged.
