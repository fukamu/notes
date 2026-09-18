# Application / presentation contracts

FUKAMU Notes separates durable data behavior, application navigation, and the
default renderer. The split is intended to let the presentation and theme be
replaced at the composition root without changing storage, sync, or domain
rules.

## Layers and dependency direction

1. `lib/domain`, codecs, and sync define trusted card data, validation, and
   deterministic data operations. Internal references continue to use the
   branded `CardId` from the type-safety contract.
2. `lib/application/notes-runtime.ts` defines provider-neutral
   `NotesRepository`, `SyncTransport`, `Clock`, `IdGenerator`, connectivity,
   and offline preparation ports. Its fixed `LEGACY_NOTES_SCOPE` preserves the
   pre-account database and endpoint without putting scope fields in cards.
3. `lib/client/notes-store.tsx` connects those injected ports to React state.
   Its public `NotesDataStore` contains data/init/save/sync/conflict behavior
   only; it does not contain the current location or view selection.
4. The rest of `lib/application` owns location transitions, application
   coordination, and pure view-model selectors. This layer has no React, DOM,
   icon, theme, SVG, or Tailwind dependency.
5. `lib/client/use-notes-application.ts` observes the browser-history navigator
   and connects the data store to the application contracts. Pathname parsing
   remains a pure application codec; the `window` adapter stays in `lib/client`.
6. `components/notes-app.tsx` is the composition root. It creates the legacy
   runtime adapter set and is the only module that selects the concrete notes,
   editor, and connections renderers and connects them to feature adapters. A
   renderer receives only the typed presentation model, semantic actions, and
   feature render callbacks.

The five supported application pages share `app/(notes)/layout.tsx`. That
layout mounts the composition root once while its empty route children change,
so browser history integration does not create a new provider or editor tree.
Unrelated paths remain outside the group and retain the framework 404.

Presentation code must not access IndexedDB, fetch, sync, service workers,
database bindings, or API routes. Application code must not select icons,
classes, colors, or DOM structure. The architecture test enforces these
boundaries alongside the existing trust-boundary and unsafe-lint checks.

## Runtime data ports and legacy compatibility

The default composition uses `createLegacyNotesRuntimePorts`. It binds the
unchanged `fukamu-notes` IndexedDB database, `/api/sync` v1 endpoint, browser
clock and UUIDv7 generator, online/offline events, and Service Worker
preparation to one explicit scope. `NotesProvider` imports none of those
concrete adapters; tests and future authenticated composition roots can supply
another complete port set.

The IndexedDB adapter still opens schema version 1 with the same four stores,
decodes all values from `unknown`, and performs the same read/write transaction
plans. The HTTP adapter sends the same POST, content type, and JSON field order.
No storage migration or wire migration occurs in this extraction. Account and
Vault ownership is represented by a session-derived `VaultContext` and
scope-bound runtime, not by adding fields to `CardRecord` or its body.
`SessionNotesApp` refuses to construct or mount the runtime while anonymous;
the current route names `LegacyNotesApp` explicitly as the local compatibility
harness until authenticated vault adapters replace it. The session boundary is
documented in [`session-boundary.md`](session-boundary.md).

## Navigation contract

`NotesLocation` is a discriminated union:

- `empty` has no card;
- `card` requires a `CardId`;
- `history` has an optional card context;
- `connections` requires a `CardId`.

It is therefore impossible to represent a connections screen without a
current card. Navigation is expressed with named intents—initialize,
reconcile cards, open a card, show the current card, show history, and show
connections—through `NotesNavigator`. The browser adapter implements that
existing port at the connector boundary. It serializes the location with the
pure pathname codec and owns `pushState`, `replaceState`, and `popstate`; the
data store, controller, model, actions, and renderers remain location-agnostic.

User-selected destinations push one history entry. Initialization,
canonicalization, missing-card reconciliation, and the first card created from
an empty root replace the current entry. A pop only applies its parsed state;
it never pushes. Query and hash are discarded during canonicalization, and
display ID changes never affect the URL because routes use branded immutable
card IDs.

A syntactically valid deep card route remains pending while local loading and
the initial synchronization can still resolve it. During that interval the
presentation receives the existing initialization state instead of rendering a
different card. When the initial attempt completes—including an offline or
failed attempt—normal reconciliation deterministically selects the last local
card, drops missing history context, or returns to the empty root. This adds a
sync-lifecycle fact to `NotesDataStore`, not navigation state.

The reducer applies these rules:

- initialization opens the last locally stored card, or `empty` if none
  exists;
- opening an unknown card is rejected by the controller;
- selecting the current semantic location is a no-op and emits no notification;
- history preserves an optional current-card context;
- connections and returning to the card view are no-ops without context;
- after deletion or any external card-set change, a missing card/connections
  location falls back to the last card, while history remains history and
  drops the invalid context;
- card creation and successful conflict resolution are data operations with no
  navigation side effect; their controller actions explicitly open the result.

## Presentation and view models

`NotesPresentationModel` provides initialization, location and active view,
available views, the current editor card, history items, current-card conflict
choices, semantic connection nodes/edges, and a semantic save/sync status. The
connections input contains labels, accessible names, current state, and branded
IDs rather than raw card records. The status selector fixes priority as
local-save failure, local save, active sync, offline, sync failure, then saved;
it also states whether retry is available.

The model is discriminated by `activeView`. It materializes editor/conflict
data only for `card`, history items only for `history`, and connection
nodes/edges only for `connections`; the two inactive heavy models are
explicitly `null`. This keeps a title/body edit from rebuilding the 10,000-card
history and connections projections while making the uncomputed state visible
to every presentation implementation. View navigation still computes the
selected projection synchronously from the same full local replica, so URL,
back/forward, offline, and renderer output contracts do not change.

The card projection carries a pure `CardEditorCandidateIndex` instead of a
freshly filtered candidate array. The index preserves the existing numeric
descending order, official/provisional tie break, created-at/card-id/source
order, current-card exclusion, labels, and `#` link format. Numeric-prefix
interaction is a direct lookup and does not scan or sort the replica on every
keystroke. Reconciliation rebuilds only when card identity/order, display ID,
title, created-at tie-break, or current-card identity changes; body, update
time, and local/server revision changes reuse the same index.

`useNotesApplication` owns the mutable reconciliation cache as an
instance-local client adapter and clears it when the mounted application hook
is destroyed. It is neither module-global nor persisted, and the authenticated
session boundary unmounts the notes application during fencing/logout. This
keeps cached labels and candidates within the mounted provider/session while
the application index construction and query remain typed pure functions. The
only result bound is 9,999 candidates: the product limit of 10,000 active cards
minus the excluded current card. No smaller UI cap or interaction behavior is
introduced by this optimization.

History and conflict previews resolve card links through a
`CardBodyTextLookup` built once per pure selector invocation. The lookup keeps
the legacy last-card-wins behavior for duplicate `CardId` fixture data and the
same official/provisional display labels, `Untitled` fallback, and missing-link
text. History therefore performs one O(cards) lookup build, its existing
O(cards log cards) sort, and O(total body segments) preview work instead of
rebuilding an all-card `Map` for every history item. All current-card conflicts
and their two options share one lookup within the batch selector call; an empty
conflict batch builds none. The lookup is not cached across selector, provider,
Vault, session, or logout boundaries.

`NotesPresentationActions` exposes semantic operations only:
`createCard`, `openCard`, `showCurrentCard`, `showHistory`, `showConnections`,
`updateTitle`, `updateBody`, `retrySync`, and `resolveConflict`. It deliberately
has no generic current-card or view setter.

History sorting, display labels, title/body fallbacks, current-item marking,
and previews are pure view-model work. A second pure boundary maps item count,
current index, fixed row geometry, and measured/unmeasured viewport state to a
bounded render range, offset, total height, and centered scroll position. The
React hook owns only `ResizeObserver`, validated scroll measurements, element
refs, and focus. History renders a semantic ordered list with `aria-posinset`
and `aria-setsize`; Arrow Up/Down and Home/End can move focus into a range that
was not mounted. It clears every ref on unmount and holds no Vault/session data
outside the mounted presentation. Conflict view models contain only the two
choices for the current card, including titles, previews, accessible action
names, and the established missing-link fallback. The renderer does not
receive all conflicts.

## Feature adapters and composition

`NotesAppConfiguration` selects the concrete `Presentation`, editor renderer
and editor presentation attributes, connections renderer, layout metrics, and
viewport padding. `NotesConnector` binds those choices to
`BodyEditorAdapter` and `ConnectionsAdapter`, then gives the selected notes
presentation two typed feature render functions. No production route, query
parameter, feature flag, or hidden switch selects an alternate design.

The default notes presentation does not import either feature adapter. The
feature adapters do not choose their concrete renderers. Consequently only the
composition root knows both a feature implementation and the concrete
presentation that consumes it. To replace the design:

1. Implement the three presentation contracts: notes, card editor, and
   connections renderers.
2. Provide editor structural attributes/link classes and connections layout
   metrics/viewport padding as presentation data.
3. Pass the resulting `NotesAppConfiguration` at the composition root.

Do not change domain, codecs, storage, sync, DB/API, `NotesDataStore`,
`NotesNavigator`, application selectors/controllers, editor controller, or
connections controller. The test-only alternate configuration demonstrates
this exact seam and is intentionally unavailable through the production UI.

The editor receives branded identity, title, body, candidate, and label models
plus semantic application actions. Its adapter receives the existing
`updateTitle` and `updateBody` operations so the renderer can expose one shared
editing history without receiving raw store/card collections. See
[Card editor contracts](card-editor.md).

## Connections contracts

The application selector converts the domain graph to `ConnectionsInputModel`:
semantic nodes, directed edges, labels, accessible names, current state, and
branded IDs. `ConnectionsController` owns the graph/metrics key, asynchronous
ELK request lifecycle, `loading | ready | error` state, stale-result rejection,
geometry mapping, current node, and complete fallback items. A current-card or
label-only update remaps the cached geometry without rerunning ELK; a graph or
metrics change starts a new request. An older promise can never replace the
new request's graph, metrics, or current semantics.

`ConnectionsLayoutMetrics` makes node width/height, port size, component/node/
edge spacing, layer spacing, and four-sided padding explicit. The default
presentation supplies the former `196 × 72` geometry and spacing values;
alternate presentations can supply compact or spacious metrics without
changing graph/layout code. ELK returns finite node, port, section, and bend
point geometry. The deterministic `connections-path` presentation core validates
finite orthogonal sections, removes duplicate and forward-collinear points, and
turns real corners into quadratic SVG commands without reading the DOM. Radius is
bounded by the presentation adapter, half of both adjacent segments, and half of
the configured edge/node clearance; endpoints and the final straight tangent are
unchanged. The memoized default edge layer recomputes these paths only when the
layout key or curve settings change. SVG elements, arrows, halo, colors,
decoration, and path layering remain in the default renderer, while the semantic
edge list remains renderer-independent input.

`useConnectionsViewport` is the browser interaction adapter. It owns Pointer
Events, pointer capture/cancellation, wheel and keyboard input, ResizeObserver,
and requestAnimationFrame scheduling. Typed pure functions own fit, pan, zoom,
pinch anchoring, centering, visibility recovery, resize preservation, and finite
camera clamps. Every camera path shares the 0.10–2.00 scale range. The same rAF
commit derives the rounded percentage and the native disabled state of the zoom
buttons, with an epsilon only for boundary-state stability. Raw moves update only
one world-wrapper CSS transform at most once per animation frame; they do not
rerender the React node/edge tree or rerun ELK.
The initial camera fits the padded graph and recovers the current card when the
minimum zoom cannot fit everything. A focus event minimally reveals the whole
node and its focus ring. Both a ready node and every error fallback item dispatch
the same typed `openCard(CardId)` action.

An explicitly selected zoom scale is a versioned device-local preference. The
client adapter decodes and clamps only that scalar, debounces gesture writes, and
flushes a pending value when the view unmounts. Re-entering the connections view
or reloading restores the scale against the latest viewport and layout, then
recenters the current card when necessary. Camera translation, layout geometry,
and current-card identity are never persisted, synced, or written to IndexedDB or
D1. Automatic fit, resize, pan, and current-card recovery do not overwrite the
preference.

The reproducible desktop/mobile continuous-gesture measurements live in
`docs/benchmarks/connections-camera-gesture.json`; the post-deployment pointer
sequence, zoom-boundary, bundle, and three-run measurements live in
`docs/benchmarks/connections-camera-follow-up.json`. A touch starts with the
browser's implicit capture on the hit descendant. When a real drag transfers
capture to the viewport, the descendant's bubbling `lostpointercapture` is not a
viewport cleanup signal; only a loss targeted at the viewport clears the active
pointer. This preserves short node taps and makes subsequent single-finger moves
continuous. Timing values are recorded as evidence rather than unstable CI gates;
deterministic one-write-per-frame coalescing is asserted in unit and browser
tests.

The production layout runner uses the installed ELK build through a dedicated
browser Web Worker. Offline preparation caches and prewarms the hashed worker
asset before declaring the app offline-ready. A four-entry bounded cache shares
in-flight and settled immutable layouts across view re-entry, evicts failures for
retry, and keys only on semantic graph structure plus layout metrics. The
controller still owns stale-result rejection and reruns layout only when that key
changes. Node tests and reproducible route benchmarks use a separate main-thread
ELK adapter that production modules do not import. Measurements and bundle impact
are recorded in `docs/benchmarks/connections-worker-cache.json`.

The routing default is ELK Layered with `RIGHT`, `ORTHOGONAL`, and `FREE` port
constraints. Endpoint side hints are omitted, so the same single ELK pass chooses
each semantic source and target port position. The adapter infers and validates
the returned NORTH/EAST/SOUTH/WEST side from finite port geometry before passing
it inward. Fixed EAST/WEST ports, relative-position two-pass layout, visibility
post-routing, and splines remain benchmark-only candidates. The full fixed-corpus
comparison and production worker evidence are in
`docs/benchmarks/connections-routing-follow-up.json` and
`docs/benchmarks/connections-routing-production.json`.

## Style and interaction boundary

Structural styles are named separately from the default visual theme:
`.card-editor-structure`, `.card-link-structure`,
`.connections-viewport-structure`, `.connections-canvas-structure`,
`.connections-world`, and `.connections-node-structure` define browser behavior
or geometry. Visual classes such as `.fukamu-editor`, `.card-link-capsule`,
`.connections-viewport`, and `.connections-node` are replaceable theme choices.
The history and connections views share a residual-height workspace shell while
the card view retains its document-scroll layout. `.history-stack` supplies
functional scroll padding and owns the remaining-height scroll area; fixed
history row geometry and viewport-bounded overscan are shared with the pure
range contract and final 10,000-card browser evidence. The connections viewport
itself is the named, focusable keyboard and gesture boundary; there is no
separate map toolbar or zoom output.

Conflict visuals use light/dark semantic `--warning-*` tokens and the shared
button primitive; no feature component embeds an amber or white palette.
Unused `.quiet-button` styling was removed after a repository-wide reference
check. The complete raw-interaction and requirement audit is recorded in
[Presentation boundary audit](presentation-boundary-audit.md).

Names use `Notes*` for application-wide contracts and `Card*` for individual
card/domain artifacts. The runtime codecs, branded identifiers, guarded trust
boundaries, atomic persistence, D1/API decoding, and unsafe-lint rules from #9
remain unchanged.

#6 replaced only the production in-memory `NotesNavigator` adapter with the
URL/History API implementation at the connector boundary. `NotesLocation`,
named intents, controllers, models, actions, renderers, and the
`NotesProvider` lifetime remain unchanged; route transitions use History API
state observation rather than mounting another provider tree. #7 audits
product-wide names as `FUKAMU Notes`/`Notes*` and user-created artifacts as
`Card`/`Card*` without conflating the two concepts. Product/application names,
URLs, cache and database identifiers remain intentionally unchanged.
