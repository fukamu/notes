# UI/UX redesign discovery baseline

Parent issue: [#72](https://github.com/fukamu/notes/issues/72)
Discovery issue: [#73](https://github.com/fukamu/notes/issues/73)
Integration branch: `redesign/72-integration`
Work branch: `redesign/73-discovery`
Branch point: `2c7e968f6b4567f73a692f384b1b2c6d569040b7`
Figma file: <https://www.figma.com/design/zVb30VcGJ02JYMmZwTcsK4>
Figma discovery page: `Issue 73 Discovery`, node `1:3`

## Confirmed repository context

- Repository: `fukamu/notes`
- Remote: `origin` at `https://github.com/fukamu/notes.git`
- Default branch: `main`
- Current redesign parent: #72
- Current integration branch: `redesign/72-integration`
- Main was fetched before branching. The recorded latest `origin/main` SHA was
  `2c7e968f6b4567f73a692f384b1b2c6d569040b7`.
- No same-purpose open GitHub issue existed before #72/#73 were created.

## Tools and skills confirmed

- Figma MCP is connected. `whoami` returned a single plan and a new design file
  was created successfully.
- Loaded and used Figma skills:
  - `figma-create-new-file`
  - `figma-use`
  - `figma-generate-design`
- Loaded Sites skills because the repository contains `.openai/hosting.json`:
  - `sites-building`
  - `sites-hosting`
- No installed skill named exactly `frontend` was found. The closest installed
  UI-related skill was `visualize`, but its instructions say it is for
  in-conversation visuals, not direct existing-app implementation. Existing app
  implementation will therefore use the repository frontend stack and the Figma
  skills above, with this limitation recorded instead of pretending a named
  Frontend skill exists.
- Browser validation used local Playwright because no direct in-app browser
  control tool was exposed. The app was still operated through a real browser.

## Product facts confirmed from README/docs/code

- FUKAMU Notes is a local-first, single-user, single-collection Web app that
  recreates paper-card Zettelkasten practice.
- The primary object is a card with immutable UUIDv7 internal identity and a
  provisional or official display number.
- Users create cards, write title/body content, insert explicit one-way links to
  other cards, browse cards by display number, and inspect the directed graph of
  all local cards and explicit body links.
- The app intentionally does not provide search, tags, recommendations,
  backlinks, multi-user permissions, images, attachments, or real-time
  collaboration.
- IndexedDB is the display/edit source of truth. Cards are valid immediately,
  even with empty title and body, and autosave has no save button.
- Sync to Cloudflare D1 is idempotent and assigns official display IDs. Conflicts
  preserve both sides and require an explicit user choice.
- Canonical paths are `/`, `/cards/:cardId`, `/history`,
  `/cards/:cardId/history`, and `/cards/:cardId/connections`.
- Presentation is intentionally replaceable at the composition root through
  typed presentation contracts. UI redesign should stay in presentation,
  editor-renderer, connections-renderer, and theme surfaces unless a separate
  issue justifies deeper changes.

## Current application surfaces

- Global header:
  - Product name and tagline.
  - New card action.
- Card view:
  - Current display ID.
  - save/sync/offline/retry status.
  - conflict notice when current card has a conflict.
  - title input.
  - rich plain-text body editor with card link capsules.
  - link candidate popover after `#`.
  - undo and redo toolbar.
- Empty state:
  - first-card explanation and new card action.
- History view:
  - scrollable stack ordered by display number.
  - current card marking.
  - title and body preview.
  - opens selected card.
- Connections view:
  - graph status: loading, ready, error fallback.
  - all local cards and explicit one-way links.
  - pan, zoom, fit, current-card centering, keyboard operation.
  - accessible edge list and fallback card list on layout error.
- Navigation:
  - card, history, and connections.
  - fixed bottom navigation on narrow widths.
  - right-side vertical navigation on large widths.

## Feature matrix

| Existing feature    | User purpose                                           | Current entry                                    | New design entry to preserve                                    | Behavior to preserve                                                                                                                 | Verification                                                    |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Create a card       | Start a new thought immediately, offline or online     | Header `新しいカード`; empty-state CTA           | Persistent primary create action and empty-state action         | Card exists immediately, empty title/body allowed, URL opens new card, provisional display ID assigned offline                       | E2E create/offline flow; card title/body visible after creation |
| Autosave title/body | Write without manual save management                   | Title input and body editor                      | Same editing surface, clearer save state placement allowed      | IndexedDB-first ordered save; no save button; status priority unchanged                                                              | Existing E2E save/reload; unit presentation/status tests        |
| Sync/retry status   | Know whether work is local, synced, offline, or failed | Status pill in card sheet header                 | Visible status in editor context; retry when retryable          | Retry only when model says retryable; labels and `data-testid=save-sync-status` preserved or test updated without weakening behavior | E2E reconnect/sync-failed cases; focused status tests           |
| Body text editing   | Capture card content as plain text                     | Tiptap editor                                    | Focused writing area                                            | Plain text + card links only; IME/composition and newline behavior preserved                                                         | E2E body fill; editor unit tests                                |
| Explicit card links | Connect ideas intentionally                            | Type `#`, choose candidate; link capsule in body | Candidate command remains discoverable from editor              | No automatic conversion of `C#`, `#123`, full-width hash, pasted URLs, or Markdown; link stores target card ID                       | Existing body/link tests and E2E link flow                      |
| Undo/redo           | Recover local editing operations                       | Editor toolbar                                   | Editor-local history controls, likely closer to writing toolbar | Tiptap undo/redo state controls button disabled state                                                                                | E2E undo/redo; editor contract tests                            |
| Conflict resolution | Avoid silent overwrite across devices                  | Conflict notice above card sheet                 | Prominent current-card resolution surface                       | Both choices visible; user explicitly chooses local/server content; no auto-merge                                                    | Existing E2E conflict preservation/resolution                   |
| History stack       | Browse previous cards by display number                | Navigation `過去のカード`                        | First-class browse mode, no search/tag addition                 | Ordered by display value; current item marked and scrolled; opens selected card                                                      | E2E history/open card; view-model tests                         |
| Connections graph   | See all cards and directed explicit links              | Navigation `つながり`                            | First-class map mode with controls retained                     | Shows all local cards including isolated cards; edges only from body links; current card highlighted; pan/zoom/fallback preserved    | E2E connections; graph/controller/path tests                    |
| Graph controls      | Navigate larger maps                                   | Fit/current/keyboard/zoom toolbar                | Equivalent controls with icon affordances                       | Scale range, keyboard shortcuts, persisted zoom preference, current-card recovery preserved                                          | E2E graph controls; unit viewport tests                         |
| URL/history         | Reopen, deep link, back/forward                        | Browser path and navigation actions              | Routes may remain identical unless separate issue proves need   | Canonical path contract; card IDs not display IDs; initialization/missing card reconciliation preserved                              | URL navigation tests and E2E back/forward                       |
| Offline readiness   | Keep writing after initial load                        | Service Worker and IndexedDB                     | UI may communicate readiness/status, behavior unchanged         | Initial app resource cache; offline reload after initial online access; no production data use                                       | E2E offline tests; service worker tests                         |

## Baseline screenshots

Saved under `docs/screenshots/redesign-72/`:

- `baseline-empty-desktop.png`
- `baseline-card-desktop.png`
- `baseline-history-desktop.png`
- `baseline-connections-desktop.png`
- `baseline-card-mobile.png`

These are evidence of the pre-redesign state, not a design target.

## Baseline verification

Commands run before implementation changes:

| Command                | Result | Notes                                                                                         |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `npm run format:check` | Passed | 161 files checked.                                                                            |
| `npm run typecheck`    | Passed | App, API, service worker, tooling, and tests all checked.                                     |
| `npm run test:unit`    | Passed | 34 files, 270 tests.                                                                          |
| `npm run lint`         | Passed | App, API, service worker, tooling, and test lint tasks passed.                                |
| `npm run build`        | Passed | Existing chunk-size warning and Vinext route classification notice appeared; build completed. |

## Local runtime observations

- `npm start -- --port 3100` failed in this container before serving the app:
  - Wrangler tried to write logs under `/home/matoruru/.config/.wrangler`, which
    is read-only in the sandbox.
  - Wrangler also hit `uv_interface_addresses returned Unknown system error 1`.
- `npm run dev -- --host 127.0.0.1 --port 3100` also hit
  `uv_interface_addresses returned Unknown system error 1` in sandboxed mode.
- A temporary `/tmp` Node preload was used only for local baseline capture to
  return a loopback `os.networkInterfaces()` result.
- Sandboxed dev-server execution then failed to bind the inspector port, so the
  dev server was started with approved unsandboxed execution for screenshot
  capture.
- During dev capture, Vinext/Vite showed an existing client overlay:
  `Uncaught ReferenceError: window is not defined` from `@vite/client`. The
  overlay blocked pointer events, so the screenshot script hid only the overlay
  element while operating the underlying app. This is recorded as a baseline
  environment/dev-overlay issue, not a redesign implementation change.

## Current UI observations

Facts:

- The current visual direction is paper-like: warm background, serif headings,
  lined card sheet, rounded surfaces, and low-density whitespace.
- Primary writing flow is centered and calm, with navigation separated to the
  side on desktop and fixed to the bottom on mobile.
- The implementation already uses semantic actions and presentation contracts,
  which supports a redesign without changing core data behavior.
- The connections view is a working graph tool rather than a static dashboard.

Design hypotheses to test in #74+:

- Daily use may benefit from stronger mode clarity and denser access to
  neighboring cards without turning the product into a search/dashboard app.
- The status/conflict/system feedback may be clearer if it is treated as a
  persistent workbench signal instead of living mostly inside the card sheet.
- Connections and history should feel like alternate thinking tools, not
  secondary pages hidden behind decorative navigation.
- The card-writing surface should remain low-friction, but the current large
  sheet can make surrounding context and navigation feel distant on desktop.

## Non-goals discovered during baseline

- Do not add search, tags, backlinks, recommendations, AI organization, folders,
  images, attachments, multi-user spaces, or permissions as part of this redesign.
- Do not change display ID semantics, URL identity, conflict semantics, D1 sync,
  IndexedDB persistence, or Service Worker behavior.
- Do not use design simplification as a reason to remove connections controls,
  conflict choices, retry state, undo/redo, or link suggestions.

## Next implementation issues

Recommended child issues after #73:

1. Design exploration and Figma direction selection.
2. Shared visual system and presentation tokens.
3. Card writing flow implementation.
4. History and connections implementation.
5. Integrated responsive, accessibility, and regression validation.
