# Application / presentation contracts

FUKAMU Notes separates durable data behavior, application navigation, and the
default renderer. The split is intended to let the presentation and theme be
replaced at the composition root without changing storage, sync, or domain
rules.

## Layers and dependency direction

1. `lib/domain`, codecs, storage, and sync define trusted card data and data
   operations. Internal references continue to use the branded `CardId` from
   the type-safety contract.
2. `lib/client/notes-store.tsx` connects IndexedDB, sync, and React state. Its
   public `NotesDataStore` contains data/init/save/sync/conflict behavior only;
   it does not contain the current location or view selection.
3. `lib/application` owns location transitions, application coordination, and
   pure view-model selectors. This layer has no React, DOM, icon, theme, SVG,
   or Tailwind dependency.
4. `lib/client/use-notes-application.ts` observes the browser-history navigator
   and connects the data store to the application contracts. Pathname parsing
   remains a pure application codec; the `window` adapter stays in `lib/client`.
5. `components/notes-app.tsx` is the composition root. It is the only module
   that selects the concrete notes, editor, and connections renderers and
   connects them to their feature adapters. A renderer receives only the
   typed presentation model, semantic actions, and feature render callbacks.

The five supported application pages share `app/(notes)/layout.tsx`. That
layout mounts the composition root once while its empty route children change,
so browser history integration does not create a new provider or editor tree.
Unrelated paths remain outside the group and retain the framework 404.

Presentation code must not access IndexedDB, fetch, sync, service workers,
database bindings, or API routes. Application code must not select icons,
classes, colors, or DOM structure. The architecture test enforces these
boundaries alongside the existing trust-boundary and unsafe-lint checks.

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

`NotesPresentationActions` exposes semantic operations only:
`createCard`, `openCard`, `showCurrentCard`, `showHistory`, `showConnections`,
`updateTitle`, `updateBody`, `retrySync`, and `resolveConflict`. It deliberately
has no generic current-card or view setter.

History sorting, display labels, title/body fallbacks, current-item marking,
and previews are pure view-model work. The current item scroll behavior lives
in a dedicated presentation hook and does not depend on a parent/button DOM
lookup. Conflict view models contain only the two choices for the current
card, including titles, previews, accessible action names, and the established
missing-link fallback. The renderer does not receive all conflicts.

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

## Style and interaction boundary

Structural styles are named separately from the default visual theme:
`.card-editor-structure`, `.card-link-structure`,
`.connections-viewport-structure`, `.connections-canvas-structure`,
`.connections-world`, and `.connections-node-structure` define browser behavior
or geometry. Visual classes such as `.fukamu-editor`, `.card-link-capsule`,
`.connections-viewport`, `.connections-map-toolbar`, and `.connections-node` are
replaceable theme choices. `.history-stack` only supplies functional scroll
padding.

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
