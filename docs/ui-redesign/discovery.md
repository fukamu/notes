# UI redesign discovery contract

Status: frozen for design comparison  
Parent: [#83](https://github.com/fukamu/notes/issues/83)  
Discovery: [#90](https://github.com/fukamu/notes/issues/90)  
Branch point: `2c7e968f6b4567f73a692f384b1b2c6d569040b7`  
Integration branch: `redesign/83/integration`  
Figma file: <https://www.figma.com/design/UCfz16t3ZU7yUYKBHNiz8r>

## Purpose and evidence boundary

This document is the non-visual contract for five independent UI proposals. It was derived from application code, typed presentation contracts, tests, and existing product documentation. Existing screenshots, CSS values, layout, type, colour, radius, decoration, and component appearance were excluded as design inputs.

The five proposals must solve the same functions, states, viewports, and accessibility requirements. A proposal may change presentation and information hierarchy, but it must not change domain, persistence, sync, URL, or permission behaviour.

Primary evidence lives in `app/`, `components/`, `hooks/`, `lib/application/`, `lib/client/`, `lib/domain/`, `lib/editor/`, `lib/graph/`, `lib/storage/`, `lib/sync/`, `tests/unit/`, `tests/integration/`, and `tests/e2e/notes.spec.ts`.

## Product boundary

FUKAMU Notes is a Japanese, local-first, single-person Zettelkasten. The central action is editing one card at a time. Connections are explicit, directed links embedded in body content. The application does not provide app-level accounts or permissions.

The redesign must not add search, tags, backlinks, AI assistance, analytics, notifications, sharing, billing, deletion, or a theme switch. Owner-only access is a hosting concern and is not an application capability.

## Routes and navigation

| Route                    | Required destination                                                |
| ------------------------ | ------------------------------------------------------------------- |
| `/`                      | Initialise and open or create the current card                      |
| `/cards/:id`             | Edit one card                                                       |
| `/history`               | View cards by recency                                               |
| `/cards/:id/history`     | View history with the referenced card represented and centred       |
| `/cards/:id/connections` | View all-card directed connections with the referenced card current |

The primary view switch exposes Card, History, and Connections. Current and unavailable destinations retain meaningful disabled/current semantics. Canonical URLs, browser history, back/forward navigation, reloads, and deep links remain functional.

## Functional catalogue

| ID    | Required behaviour                               | Essential states or constraints                                                                                                 |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| F-001 | Initialise application and resolve direct routes | loading, success, recoverable failure, canonical route                                                                          |
| F-002 | Create a card                                    | provisional identity may precede official identity                                                                              |
| F-003 | Edit title and rich body with autosave           | title and body remain separate; no explicit save requirement                                                                    |
| F-004 | Communicate save and sync status                 | precedence among initialising, editing/saving, saved, syncing, synced/offline, failed; retry is exposed only for a sync failure |
| F-005 | Switch among Card, History, and Connections      | current/disabled semantics and URL updates                                                                                      |
| F-006 | Browse history in descending recency             | current card, open action, and route-specific centring                                                                          |
| F-007 | Mix text and explicit card links in body content | body remains editable; links are first-class document content                                                                   |
| F-008 | Find and choose link candidates                  | keyboard and pointer operation; result and no-match states                                                                      |
| F-009 | Activate and remove an explicit link             | navigation and unlinking preserve surrounding document content                                                                  |
| F-010 | Undo and redo editing                            | editor identity and history survive rerender/reconciliation boundaries                                                          |
| F-011 | Show the directed graph for all cards            | isolated, disconnected, self, mutual, and cyclic links remain representable                                                     |
| F-012 | Communicate graph lifecycle                      | loading, ready, failure fallback, and no-edge state                                                                             |
| F-013 | Navigate graph camera                            | pan, zoom, fit, current-card focus, keyboard, pointer, and touch                                                                |
| F-014 | Persist zoom preference locally                  | validated local preference; invalid external values do not reach core logic                                                     |
| F-015 | Synchronise automatically and manually           | local-first edits remain usable offline; manual retry/action respects sync state                                                |
| F-016 | Preserve edits while sync is in flight           | remote completion cannot overwrite newer caller-owned draft state                                                               |
| F-017 | Reconcile provisional and official IDs           | links, routes, and current-card identity follow reconciliation                                                                  |
| F-018 | Create conflicts without silent overwrite        | both versions are preserved and conflict is explicit                                                                            |
| F-019 | Resolve a conflict by explicit choice            | chosen version is deliberate; the alternative is visible before resolution                                                      |
| F-020 | Operate offline through the service worker       | application shell and local editing remain available within the existing contract                                               |

## State inventory

Every proposal must demonstrate the normal editing flow plus the following exceptional or transitional states where they materially affect layout:

- application initialising and initialisation failure;
- new/provisional card and official-ID reconciliation;
- unsaved change, saving, saved, syncing, synced, offline, and sync failure with retry;
- link candidate results, keyboard selection, and no match;
- empty history and history containing long Japanese titles;
- graph loading, graph ready, no edges, isolated nodes, and graph failure fallback;
- conflict with both local and remote versions before explicit resolution.

State priority and available actions come from the presentation contracts; visual prominence may vary by proposal, but action availability may not.

## Content and stress data

Designs use synthetic Japanese data only. They must cover an empty value, an untitled card, a long unbroken title, multi-paragraph body text, inline links mixed with punctuation, a practical history list, many graph nodes, disconnected subgraphs, self-links, and mutual links. Lorem ipsum and production, personal, or secret data are not allowed.

## Accessibility contract

- Native title textbox accessible name: `カードのタイトル`.
- Multiline body editor accessible name: `カードの本文`.
- View switch accessible name: `表示切り替え`; current and disabled destinations are programmatically exposed.
- Save/sync status changes are announced without stealing focus.
- Conflict UI has alert semantics and an explicit choice for each preserved version.
- Connections nodes are keyboard-operable controls. A non-visual semantic edge list preserves graph relationships independently of geometry.
- Pointer and touch targets are at least 44 by 44 CSS pixels unless an equivalent spacing exception is documented.
- Focus remains visible, order follows reading order, and no required information relies on colour alone.
- Target is WCAG 2.2 AA. Automated contrast and semantic checks complement, not replace, keyboard, touch, zoom, and screen-reader-oriented manual review.

## Responsive comparison contract

Each proposal includes at least:

- desktop Chrome at `1440 × 1024`;
- Pixel 7 class mobile at `412 × 915`;
- one intermediate-width reasoning note describing when layout changes rather than merely scales.

The same information and actions remain reachable across sizes. Mobile may stack or relocate controls, but it may not drop status, retry, conflict choice, graph camera actions, or link candidate operation.

## Architecture and implementation constraints

The redesign connects through `NotesAppConfiguration` and the existing editor, history, and connections presentation contracts. Deterministic decisions, transformations, and state transitions remain typed pure functions. React, DOM, browser APIs, clock, UUID, IndexedDB, D1, service worker, and network access remain adapters. External values are decoded once at boundaries; discriminated unions and exhaustive handling represent important alternatives.

No proposal authorises API, database schema, persistence, sync, ID allocation, conflict, authentication, or permission changes. Presentation-only copy changes that imply new behaviour require a separate decision rather than being smuggled into a design.

## Five-proposal comparison protocol

| Proposal                              | Issue | Git branch                                 | Figma page             | Distinguishing question                                                        |
| ------------------------------------- | ----- | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| A — Quiet Manuscript / 静かな原稿     | #84   | `redesign/83/proposal-01-quiet-manuscript` | `A — Quiet Manuscript` | Can the interface disappear behind sustained writing?                          |
| B — Index Ledger / 索引台帳           | #85   | `redesign/83/proposal-02-index-ledger`     | `B — Index Ledger`     | Can precise identifiers and chronology make the collection legible?            |
| C — Spacious Archive / 余白のある書庫 | #86   | `redesign/83/proposal-03-spacious-archive` | `C — Spacious Archive` | Can calm spatial hierarchy make a growing collection feel navigable?           |
| D — Editing Desk / 編集卓             | #88   | `redesign/83/proposal-04-editing-desk`     | `D — Editing Desk`     | Can explicit tools and status improve confidence without becoming a dashboard? |
| E — Connected Sheet / 連結する紙面    | #87   | `redesign/83/proposal-05-connected-sheet`  | `E — Connected Sheet`  | Can writing and graph context feel continuous without inventing backlinks?     |

All proposal branches start at `2c7e968f6b4567f73a692f384b1b2c6d569040b7`. They are comparison branches and are not merged into the integration branch before explicit user selection in #89. Their Figma variables, components, and frames use proposal-prefixed names and stay on separate pages.

The comparison evaluates functional coverage, writing focus, Japanese readability, hierarchy, state clarity, keyboard and touch operation, responsive behaviour, contrast, graph comprehension, implementation complexity, and consistency with the local-first product character.

## Baseline verification

Baseline was observed before redesign changes:

- `npm run build`: pass; existing large-chunk warning remains informational.
- `npm run test:integration`: 1 file / 10 tests passed.
- `npm run test:e2e`: 36 / 36 passed across desktop and mobile projects.
- focused ELK suites: 2 files / 56 tests passed.
- full unit/verify runs exposed an existing parallel timing sensitivity in 5-second ELK layout/research tests; one independent full unit run passed all 270 tests. This is recorded as baseline timing behaviour and must not be hidden by weakening checks.

Every implementation PR still runs its focused checks, `git diff --check`, and `npm run verify`. A timing failure is investigated and recorded; it is not reclassified as success merely because it resembles the baseline.

## Delivery and authority gates

Design proposal branches remain unmerged until #89 records the user's choice. Implementation starts from the latest integration branch only after selection. Each implementation Issue receives one branch and one PR. No work in this parent changes `main`, enables auto-merge, deploys the application, or changes production D1/data without a new direct user instruction identifying that action.
