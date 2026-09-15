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

The baseline measures connections input construction only. Issue #266 selected
progressive disclosure around the current card with fixed worker/DOM bounds;
Issue #275 removes the connections-only search path without changing those
bounds. The longer-term experience beyond the 256-card stage remains tracked
separately.

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

The final browser run intentionally does not activate a 10,000-node connections
graph. Demand-driven presentation proves that card/history views do not build
it, while the existing typed input-boundary measurement remains 15.272 ms
median and 16.709 ms p95. This remains evidence for demand-driven,
current-neighborhood staged disclosure rather than a reason to activate the full
10,000-node graph.
