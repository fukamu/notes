# Card editor controller, adapter, and renderer

The card editor preserves the stored body format and existing UI while making
its interaction behavior reusable independently of the default popup,
toolbar, icons, and theme.

## Responsibilities and dependencies

- `lib/domain/body.ts` performs the immutable link-candidate ordering. It sorts
  display numbers numerically descending, then resolves equal values by official
  before provisional, creation time ascending, card ID, and original input order.
  `lib/editor/card-editor-state.ts` is the pure candidate/input/lifecycle state
  machine. It classifies direct input versus active IME composition, decodes the
  ASCII numeric prefix after a valid hash, filters candidate display values,
  applies Arrow/Enter/Escape behavior, and distinguishes card identity reset from
  same-card external body synchronization.
- `lib/editor/use-card-editor.ts` is the headless React/Tiptap adapter. It owns
  editor creation/destruction, title/body synchronization, selection/focus
  state, candidate trigger position, composition state, candidate insertion,
  and the shared Undo/Redo commands. It consumes `CardEditorInputModel` and the
  existing `NotesPresentationActions.openCard/updateTitle/updateBody`
  contract. It has no icon, Tailwind, theme, store, storage, sync, or API
  dependency.
- `lib/editor/card-link-extension.ts` defines the atomic Tiptap node and its
  NodeView adapter. Visual class names and the instance label resolver are
  injected. The adapter decodes third-party attributes with the #9 codec
  boundary before dispatching a branded `CardId`.
- `components/body-editor-adapter.tsx` connects the application input and
  actions to the headless hook and receives its renderer and presentation
  adapter from the composition root.
- `components/body-editor.tsx` is the default renderer. It receives only a
  typed `CardEditorModel` and `CardEditorCommands`; it owns the current popup,
  toolbar, icons, spacing, colors, and copy.

An alternative renderer can provide different content and NodeView classes,
then render the same model/commands. `components/notes-app.tsx` is the only
place that binds that concrete renderer to the headless adapter. The renderer
does not need the notes store, navigation implementation, IndexedDB, sync
protocol, or Tiptap event logic.

## Body and structural contract

Persistence remains a separate title string and ordered `BodySegment[]` of text
and branded card-link segments. `segmentsToEditorDocument` maps them to a
Tiptap editing document containing a transient `cardTitle` document attribute,
a paragraph, text, hard breaks, and `cardLink` nodes;
`editorDocumentToSegments` validates link attributes and normalizes adjacent
text while preserving whitespace and line breaks. Hash-like text never becomes
a link unless a candidate is explicitly selected. The title attribute exists
only inside the active editor. IndexedDB, sync, API, and D1 keep the existing
title/body fields and formats.

`cardLink` is inline, atomic, selectable, draggable, and
`contenteditable=false`. The `data-card-link-id` attribute remains the
serialization/semantic carrier only; operation dispatch never queries it from
a parent with a CSS selector. `.card-editor-structure` supplies functional
content whitespace, wrapping, minimum editing area, paragraph height, and
outline behavior. `.card-link-structure` supplies the inline atomic label
shape and non-wrapping behavior. `.fukamu-editor` and `.card-link-capsule`
contain the replaceable default typography, color, border, padding, icon-like
arrow, shadow, hover, and selection treatment.

The raw contenteditable element remains because Tiptap/ProseMirror needs a
browser selection, composition events, native beforeinput/input behavior, and
atomic node selection to provide Undo/Redo and IME safely. It has
`role=textbox`, accessible name `カードの本文`, and `aria-multiline=true`.

## Card links and labels

Each editor creates its own `CardLabelResolver`. Application selectors supply
all current labels as plain `cardId/label` records and descending candidate models
with their numeric display values;
title or display-ID changes replace only that resolver’s map and notify only
its subscribers. Missing targets render `リンク先なし`. Every NodeView
unsubscribes and removes its event listeners on destroy, while editor unmount
destroys the resolver. Two mounted editors cannot overwrite one another’s
labels or listeners.

The NodeView installs direct click and keydown listeners. Click, Enter, and
Space call the same `activateCardLink` function, which validates attributes and
invokes `openCard(CardId)` once. It does not bubble a synthetic click or rely on
`closest`, `parentElement`, or a specific ancestor shape. Backspace deletes an
atomic link immediately before the cursor; Delete handles the corresponding
node after the cursor.

## Identity, external updates, and shared history

The Tiptap hook’s explicit dependency is `cardId`. A different identity
destroys the old instance and creates a new one from the selected card title
and body, which establishes a fresh Undo/Redo boundary and resets pending title,
candidate, composition, focus, and selection state. The renderer does not use
a React `key` to obtain this behavior. The title input is transiently disabled
until that editor identity is ready, so a rapid card switch cannot apply text
to the previous card.

Title input updates the visible value and existing autosave action on every
input. During one focus/composition session, the editing document keeps the
session’s `before` title. Blur, transfer to the body, or Undo/Redo commits the
latest `after` title as one public `setDocAttribute` transaction bounded by
`closeHistory`. Body changes use the same ProseMirror history plugin, so title
and body events are replayed in their real chronological order. Starting a new
title session disables redo immediately; committing that session creates the
new branch. Platform shortcuts in either input are routed once to the same
commands and are ignored while IME composition is active.

Each editor update compares title and body independently with the last value
sent through the application actions. A title-only history step calls only
`updateTitle`; a body-only step calls only `updateBody`. A matching application
rerender is a self echo and retains history. If the same card instead receives
different external title or body content, the editor document and its plugin
state are recreated from that content, clearing pending input and old history
so Undo cannot resurrect a stale version.

## Input and accessibility contract

- Active IME composition records input without opening candidates. The final
  composition event is inspected once composition ends.
- Only a typed half-width `#` at an allowed boundary opens candidates. With no
  digits, all non-current candidates appear in numeric descending order. Typed
  ASCII digits keep the popup open and filter the numeric display value by
  prefix: `#3` includes `#3` and `#30`–`#39`; `#32` matches values beginning
  with `32`. Paste, `C#`, full-width `＃` or digits, URL fragments, and
  Markdown-style link fragments do not open candidates and never auto-link.
- Equal display values remain deterministic: official precedes provisional,
  followed by creation time, card ID, and original input order. Exact matches
  are not promoted or converted automatically.
- ArrowUp/ArrowDown wrap the active candidate, Enter chooses it, and Escape
  closes the list. Mouse/touch choice preserves editor focus so insertion uses
  the original selection. Keyboard movement scrolls the active item into the
  popup viewport, whose height is bounded by the browser viewport.
- Candidate choice replaces only the `#digits` trigger and inserts an atomic
  link, then closes the suggestion state. Blur, Space, punctuation, an unhandled
  Enter, Escape, or any other unselected completion only closes the popup; the
  typed text remains ordinary editor content. Candidate list names and
  `aria-current` remain the renderer contract.
- The toolbar keeps `role=toolbar` and accessible name `編集履歴`; its existing
  buttons and platform keyboard shortcuts execute the same title/body Tiptap
  Undo/Redo history and expose pending-title availability before blur. After a
  history step, focus follows the field that changed instead of always moving
  to the body.
- A card link uses `role=link`, is focusable, has an action-oriented accessible
  label, and supports click/tap, Enter, and Space.

All application/domain IDs remain branded and third-party Tiptap attributes are
decoded at their boundary. No title/body storage, IndexedDB, API, D1, sync, or
navigation format changed in this phase.
