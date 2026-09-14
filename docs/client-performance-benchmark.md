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

## Known boundary

The baseline measures connections input construction only. Whether 10,000-card
connections should show every card or progressively disclose the current-card
neighborhood/search results remains Decision Required in #106 and #126.
