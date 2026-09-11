# Presentation boundary and #8 audit

This document records the final Phase 3 boundary, the interactive-element
contract, and the implementation evidence for parent issue #8 requirements
1–29. It is an architecture audit, not a new product design.

## Dependency boundary

The allowed direction is domain/codecs/storage/sync/API → data store and
navigation → application selectors/controllers → headless feature adapters →
presentation renderers/theme → composition root. The composition root is the
only place that selects both feature adapters and concrete renderers.

`tests/unit/architecture.test.ts` prevents presentation-to-infrastructure,
controller-to-renderer/style, and non-root concrete-wiring imports. The #9
strict TypeScript, full unsafe lint, runtime codecs, branded IDs, trust-boundary
tests, and CI commands remain in place without exclusions or suppressions.

The alternate presentation under `tests/fixtures` is deliberately test-only.
It uses a different theme/metrics configuration and consumes all four
locations, history/current, status/retry, conflicts, editor candidates/state/
Undo/Redo/link command, and connections loading/error/ready/node/edge/open
contracts. Its tests call representative application and feature commands; it
is not an empty component that merely satisfies a type. It imports neither the
default renderers/theme nor storage, network, service worker, or internal
domain implementations.

## Raw interactive element audit

| Element                   | Why raw/native remains                                           | Role and name                                                             | Focus, keyboard, and touch contract                                    |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Title input               | Native single-line editing, selection, and IME                   | textbox, `カードのタイトル`                                               | Native focus/edit/IME; touch caret; updates typed title action         |
| Tiptap contenteditable    | ProseMirror selection, composition, input, atomic nodes, history | multiline textbox, `カードの本文`                                         | Native focus/IME; candidate keys; platform Undo/Redo; touch caret      |
| Card link NodeView        | Atomic inline semantic navigation inside contenteditable         | link with action-oriented card label                                      | Direct click/tap and Enter/Space call typed `openCard` once            |
| Candidate buttons         | Selection must retain editor insertion point                     | named buttons inside `リンクするカードを選ぶ`; active uses `aria-current` | Arrow keys/Enter/Escape through editor; click/tap preserves focus      |
| Undo/Redo buttons         | Toolbar commands need disabled availability                      | named buttons in toolbar `編集履歴`                                       | Tab + Enter/Space and touch; same history as shortcuts                 |
| Navigation buttons        | Three semantic application intents                               | nav `表示切り替え`; named buttons; active uses `aria-current=page`        | Tab + Enter/Space and touch; disabled without card context             |
| History cards             | Semantic selection of a completed item model                     | named buttons; current uses `aria-current`                                | Tab + Enter/Space and touch; current ref scrolls without parent lookup |
| Conflict choices          | Explicit destructive ambiguity resolution                        | alert plus accessible choice buttons using shared `Button`                | Tab + Enter/Space and touch; typed conflict choice                     |
| Status button             | Retry is an optional action, not a link                          | live named button; disabled unless retryable                              | Tab + Enter/Space/touch only when retryable                            |
| Connection nodes/fallback | Every card must remain selectable if layout succeeds or fails    | named buttons; current uses `aria-current`; semantic edge list is named   | Tab + Enter/Space and touch; both variants call the same `openCard`    |
| Scrollable graph viewport | Large directed graph requires two-axis pan                       | labelled region with busy state                                           | Wheel/trackpad/touch pan; current/resize notifications center safely   |

Native buttons are retained where they provide correct keyboard activation,
focus, disabled, and touch behavior without recreating those semantics. SVG is
decorative (`aria-hidden`); directed meaning is exposed by the accessible edge
list and tested independently from path tags or marker attributes.

## Structural CSS and theme

Editor and connections structural classes define only required editing,
atomicity, wrapping, scroll/pan, positioning, and geometry behavior. History's
structural class defines current-item scroll padding. Typography, palette,
border, shadows, icons, spacing decoration, hover, and halo remain presentation
theme choices. Conflict uses semantic warning tokens with both light and dark
values. Removing or renaming structural classes requires a feature-contract
test; replacing visual classes/tokens does not require domain or controller
changes.

## Requirements 1–29

| #   | Requirement evidence                                                                        | Automated evidence                                  |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `NotesDataStore` owns data/init/save/sync/conflicts only                                    | architecture + controller tests                     |
| 2   | location/current/view transitions are outside the store                                     | architecture tests                                  |
| 3   | discriminated `NotesLocation` represents only valid contexts                                | navigation type/unit tests                          |
| 4   | navigation and features reuse validated branded `CardId`                                    | type-contract + codec tests                         |
| 5   | named intents and URL-backed `NotesNavigator` preserve behavior                             | navigation + URL/history tests                      |
| 6   | application controller coordinates data operations and navigation                           | notes-controller tests                              |
| 7   | initialization, same/missing card, reconcile, and conflict rules are explicit               | navigation + controller tests                       |
| 8   | stable `NotesPresentationModel` / `NotesPresentationActions`                                | presentation contract tests                         |
| 9   | actions are semantic intents, with no generic view/current setter                           | architecture + controller tests                     |
| 10  | store hook and concrete wiring are confined to `notes-app`                                  | architecture tests                                  |
| 11  | headless editor owns lifecycle, IME, candidates, link, history, reset                       | editor state/hook/contract tests                    |
| 12  | editor renderer receives typed model and commands                                           | body-editor contract test                           |
| 13  | identity reset differs from same-card external synchronization                              | card-editor-state + E2E                             |
| 14  | direct typed links and instance label resolver preserve codec/brand                         | link extension/label/codec tests                    |
| 15  | editor structural DOM/CSS and a11y are explicit and theme-neutral                           | editor architecture + E2E                           |
| 16  | History sort/preview/fallback/current is a pure view model                                  | view-model tests                                    |
| 17  | current-history scrolling uses an explicit ref hook                                         | architecture + E2E                                  |
| 18  | Conflict options and typed resolution are precomputed                                       | view-model/controller tests                         |
| 19  | Status priority/label/retry semantics are precomputed                                       | view-model + alternate tests                        |
| 20  | graph key, async layout, stale rejection, and three states are outside SVG                  | connections-controller tests                        |
| 21  | semantic nodes/edges/geometry/current/fallback and typed open are complete                  | controller + alternate tests                        |
| 22  | graph and metrics changes supersede stale promises/current state                            | controller tests                                    |
| 23  | all node/spacing/padding metrics are explicit; compact/spacious work                        | ELK layout tests                                    |
| 24  | centering takes viewport/node/padding/current/resize inputs safely                          | viewport unit + E2E                                 |
| 25  | controllers/view models contain no renderer, icon, theme, SVG, or DOM dependency            | architecture tests                                  |
| 26  | semantic tokens/UI primitive remove fixed Conflict palette                                  | architecture/style tests                            |
| 27  | raw controls have role/name/focus/keyboard/touch contracts                                  | this audit + semantic E2E                           |
| 28  | structural CSS and visual theme are separated; unused style removed                         | architecture + reference audit                      |
| 29  | existing desktop/mobile UI, copy, a11y, focus, scroll, keyboard/touch and operations remain | full Desktop Chrome/Pixel 7 E2E + visual comparison |

## Follow-on boundaries

#6 adds the URL/History API implementation of `NotesNavigator` at the
connector boundary. Pure parsing stays in `lib/application`, browser effects
stay in `lib/client`, and no URL state moves into the store, controllers, or
renderers. The model/actions and feature contracts are unchanged.

#7 audits `FUKAMU Notes`/`Notes*` for the product/application and `Card`/`Card*`
for user-created artifacts across filenames, exports, UI copy, tests, and docs.
The two inconsistent public descriptions use “Webアプリ”; storage, schema,
API, cache, URL, package, and product identifiers remain unchanged.

No DB, D1 API, IndexedDB, sync protocol, numbering rule, editor/graph library,
deployment, or production data is changed by this boundary work.
