# Connections corridor layout core (Issue #316)

## Decision

The complete-network implementation uses two layout engines without changing
graph membership:

- ELK remains the small-graph engine while the complete input has at most 256
  nodes and 1,024 directed edges.
- A deterministic corridor engine is selected above either boundary.

The values select a calculation method; they are not display limits and do not
claim that every graph inside the boundary is safe for ELK. The later hybrid
Worker adapter will retry the same unmodified input with the corridor engine
when ELK fails or exceeds its reviewed deadline. The policy revision includes
the selection boundary and geometry-affecting corridor settings so a later
cache cannot reuse incompatible coordinates.

Issue #316 added the typed pure geometry core and policy only. Issue #318 now
connects it to the product hybrid Worker manager, while the production
64/64/256 staging UI and product rendering performance remain separate review
steps under parent Issue #304.

## Geometry algorithm

`layoutConnectionsCorridors` validates metrics and endpoints before producing
the existing `ConnectionsLayout` contract. It never reads browser state,
storage, clocks, random values, or caller-owned mutable state.

1. Build an ID index and undirected adjacency from the complete directed edge
   list. Extract weakly connected components with iterative breadth-first
   search; self references stay in the directed routing input.
2. Inside each component, start breadth-first traversal at the lowest-incidence
   node, use card ID as the deterministic tie-break, and reverse the traversal
   order as a bounded RCM-like heuristic. This is not an optimal RCM or
   pseudo-peripheral search.
3. Place that order in a serpentine 16:9-oriented grid. Viewport dimensions are
   not an input, so resize does not change geometry.
4. Give every directed edge independent north/south ports. Route through empty
   horizontal and vertical corridors using at most three vertical candidates.
   Allocate overlapping closed intervals to separate lanes with min-heaps;
   touching intervals cannot reuse a lane.
5. Size corridors from their lane counts, build orthogonal routes with at most
   six points, and retain the existing curve function as the presentation
   layer. A self reference uses two ports and a non-degenerate U route.
6. Shelf-pack component layouts by height and stable component ID, then restore
   every node and edge to original input order. IDs remain `edge-{index}` and
   `port-{index}-{source|target}`, preserving the controller's positional join.

The principal retained data is proportional to nodes, edges, route intervals,
ports, and output points. Sorting gives an upper-bound target of
`O((N + E) log(N + E))` time and `O(N + E)` retained data. The occupied world
area can grow with busy corridor lane counts; this implementation does not
claim a linear-area bound or edge-crossing minimization.

## Fixed values and invariants

- Corridor lane spacing: 8 world units.
- Edge/card clearance: `max(16, edgeNodeSpacing)`.
- Desired component grid and packing aspect: 16:9.
- Vertical candidate congestion cost: Manhattan grid distance plus 0.05 per
  interval already assigned to the candidate corridor.
- Port margin: at most 16 world units, bounded to one quarter of card width.
- Component gap: the existing `componentSpacing` metric.
- Product curve compatibility checks use maximum radius 16 and node clearance
  32, matching `defaultConnectionsPresentation`.

Tests cover input immutability, deterministic output, original node/edge order,
finite orthogonal geometry, independent endpoint ports, self and mutual
references, curve generation, and conservative line/quadratic bounds against
card interiors. They execute the existing 257 mixed, 1,000/3,000, product
10,000/~19,951, and connected 10,000/20,000 complete inputs without reducing
nodes or edges.

## Evidence boundary

The focused pure-core suite returns complete geometry for all required fixtures.
That result establishes algorithmic executability and structural correctness in
the test process. It is not a Chromium Worker measurement, a React commit/paint
measurement, a memory budget, or evidence that the large corridor view is
visually equivalent to the small ELK view.

The saved ELK failures in
[`connections-browser-worker-feasibility.md`](connections-browser-worker-feasibility.md)
remain historical evidence and are not overwritten. Issue #318 exercises this
core through the product Worker manager, validates unknown Worker responses,
implements one active plus one latest pending request, and preserves
reset/logout generation safety. Its evidence and limits are recorded in
[`connections-hybrid-worker.md`](connections-hybrid-worker.md). Product
SVG/DOM performance and any conditional Canvas decision remain later
measurements.
