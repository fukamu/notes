# Figma five-proposal foundation

Parent: [#83](https://github.com/fukamu/notes/issues/83)

Issue: [#91](https://github.com/fukamu/notes/issues/91)

Figma: <https://www.figma.com/design/UCfz16t3ZU7yUYKBHNiz8r>

Exact branch point: `285adc7e37cec3953ab97bce1323b46110130b39`

Target: `redesign/83/integration`

## Separation model

The Figma file contains two documentation pages followed by one page per proposal. Each proposal owns its primitive and semantic collections, typography styles, component sets, and screen frames. Proposal-prefixed entities prevent an edit in one direction from silently changing another.

The comparison page is neutral documentation, not a sixth product theme. The shared constraints page mirrors the non-visual contract in `discovery.md`.

| Figma page                   | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `00 — Comparison & Contract` | Five-direction index and selection gate                              |
| `01 — Shared Constraints`    | F-001–F-020, states, viewports, accessibility, exclusions, authority |
| `A — Quiet Manuscript`       | Proposal A only                                                      |
| `B — Index Ledger`           | Proposal B only                                                      |
| `C — Spacious Archive`       | Proposal C only                                                      |
| `D — Editing Desk`           | Proposal D only                                                      |
| `E — Connected Sheet`        | Proposal E only                                                      |

## Proposal-local system shape

Each proposal has:

- a primitive collection with light/dark colour values, spacing, radii, strokes, touch size, measures, and font-family handoff values;
- a semantic Theme collection with Light and Dark modes;
- 12 semantic colours that alias proposal-local primitives;
- explicit variable scopes and complete `WEB` code syntax;
- five text styles: Display, Title, Body, UI, and Meta;
- a four-variant Button set (`Style × State`) with editable label property;
- a two-variant Navigation Item set with editable label property;
- Save Status and Graph Node components;
- Desktop Editor, Mobile Editor, Desktop History, Desktop Connections, and Desktop Conflict frames.

All five systems passed an audit for collection counts, modes, code syntax, semantic scopes, and alias targets. The final count is 275 proposal variables plus the documentation collection; proposal E has one additional `radius/pill` primitive after visual QA separated it from `radius/dialog`.

## Visual differentiation

- A — document-first, centred manuscript, serif title, muted green, sparse chrome.
- B — index rail, ruled ledger, tabular identity and chronology, blue accent, square geometry.
- C — three-part archive cabinet, warm paper, serif/gothic pairing, generous surfaces.
- D — tool rail, working sheet, status inspector, compact orange utility language.
- E — writing sheet beside the current body-link trail, teal nodes and one-way paths.

The E link trail is limited to links explicitly present in the current body. It is not a backlink, search, or recommendation feature.

## Validation performed

- all required page IDs and top-level screen IDs exist;
- every proposal has five required screen frames at `1440 × 1024` or `412 × 915`;
- every proposal has two component sets with expected variants and TEXT properties;
- every proposal has a Graph Node component;
- proposal frame left-overflow audit: zero findings;
- desktop Editor screenshots inspected for A–E;
- Pixel 7-class Editor screenshots inspected for A–E;
- Connections screenshots inspected for A–E;
- one-way arrow markers added after graph review;
- E's initial full-pill dialog radius caused text clipping, was split into `radius/dialog = 28` and `radius/pill = 999`, and was re-rendered successfully;
- failed graph-label font writes for B–D were atomic; the corrected pass loaded each actual styled text segment and then succeeded.

The canonical IDs are stored in `figma-ledger.json`. Figma is the editable visual source; the ledger is the stable traceability source for later implementation.

## Selection and delivery gate

Proposal branches are comparison branches and are not merge targets. Issue #89 must record the user's explicit selection before implementation issues are created. This foundation does not authorise runtime, API, database, sync, main, deployment, or production-data changes.
