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
4. `lib/client/use-notes-application.ts` observes the in-memory navigator and
   connects the data store to the application contracts.
5. `components/notes-app.tsx` is the composition root. The default renderer
   receives only `NotesPresentationModel` and `NotesPresentationActions`.

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
connections—through `NotesNavigator`. #13 supplies an in-memory adapter. The
URL adapter in #6 will implement the same port at the connector boundary; it
does not require changes to the data store, controller, or default renderer.

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
choices, connection graph context, and a semantic save/sync status. The status
selector fixes priority as local-save failure, local save, active sync,
offline, sync failure, then saved; it also states whether retry is available.

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

## Temporary adapter exceptions

The editor still receives card records and the local card collection required
by its existing body/link adapter. #14 removes this temporary editor coupling.
The connections renderer still receives its derived graph plus card records
needed by the existing ELK layout/labels. #15 replaces that internal adapter.
Neither exception permits direct store, storage, sync, or navigation access,
and new coupling must not be added before those issues are implemented.

Names use `Notes*` for application-wide contracts and `Card*` for individual
card/domain artifacts. The runtime codecs, branded identifiers, guarded trust
boundaries, atomic persistence, D1/API decoding, and unsafe-lint rules from #9
remain unchanged.
