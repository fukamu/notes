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

The editor receives branded identity, body, candidate, and label models plus
semantic application actions; it no longer receives raw store/card
collections. See [Card editor contracts](card-editor.md).

## Connections contracts

The application selector converts the domain graph to `ConnectionsInputModel`:
semantic nodes, directed edges, labels, accessible names, current state, and
branded IDs. `FullNetworkLayoutController` converts the complete semantic graph
to compact topology, owns the asynchronous Worker lifecycle, rejects stale or
malformed results, and retains the last complete layout during a refresh. A
current-card, title, or accessible-label change updates the retained semantic
input without recomputing topology. Only a node/edge identity change starts a new
layout request.

The pure full-network layout, routing, render-plan, camera, and accessibility
modules contain no React, DOM, Worker, storage, clock, or network effects. The
Worker receives Card IDs and numeric source/target arrays but never card titles or
bodies. Deterministic component-aware placement retains isolated cards,
disconnected components, self-links, and both directions of mutual links. Detail
routing uses node-safe cell corridors; it never changes graph membership.

The default renderer owns a retained, viewport-sized overview canvas and a detail
canvas. WebGL2 uploads the complete overview geometry once per layout key;
Canvas2D builds the same complete geometry in bounded animation-frame chunks when
WebGL2 is unavailable. Pan and zoom reuse the retained overview. The pure semantic
plan changes from Overview to Network to Detail by projected node size and only
the visible detail window materializes labels, card shapes, directional routes,
and hit targets. Every card and unique directed link remains represented at all
levels; there is no search or 64/256-card staging path.

`FullNetworkCameraAdapter` owns Pointer Events, capture/cancellation, wheel,
keyboard, resize, and animation-frame coalescing. Pure camera functions own fit,
pan, anchored zoom, pinch, centering, selection activation, resize restore, and
finite clamping. The initial view fits the complete graph. “現在地” is the only
automatic current-card centering command; opening a card does not silently
recenter the map. Camera, selection, and semantic level live in a map session
owned by the exact Notes runtime scope. They survive card/history/connections
navigation in that runtime but are not written to localStorage, IndexedDB, D1, or
sync and are discarded on logout/runtime destruction.

One bounded accessibility proxy exposes complete node/link counts and a logical
cursor without creating 10,000 hidden DOM nodes. Keyboard commands can enumerate
all nodes and edges, follow adjacent links, and move between disconnected
components. At Detail, at most one 44-pixel target per viewport cell is emitted.
Worker, renderer, and context failures have explicit status and retry actions;
they never silently fall back to an incomplete graph.

The former ELK/SVG implementation remains only as reproducible historical routing
research and tests. Production modules do not import its main-thread adapter,
path builder, or ELK layout. Current architecture and measurements are recorded
in [ADR 005](adr/005-full-network-semantic-zoom.md).

## Style and interaction boundary

Structural styles are named separately from the default visual theme:
`.card-editor-structure`, `.card-link-structure`,
`.connections-viewport-structure` and `.connections-full-network-layer` define
browser behavior or geometry. Visual classes such as `.fukamu-editor`,
`.card-link-capsule`, `.connections-viewport`, and `.connections-map-toolbar` are
replaceable theme choices. `.history-stack` only supplies functional scroll
padding; fixed history row geometry and viewport-bounded overscan are shared
with the pure range contract and final 10,000-card browser evidence.

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
