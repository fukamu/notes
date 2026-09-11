# Card editor controller, adapter, and renderer

The card editor preserves the stored body format and existing UI while making
its interaction behavior reusable independently of the default popup,
toolbar, icons, and theme.

## Responsibilities and dependencies

- `lib/editor/card-editor-state.ts` is the pure candidate/input/lifecycle state
  machine. It classifies direct input versus active IME composition, validates
  hash context, applies Arrow/Enter/Escape behavior, and distinguishes card
  identity reset from same-card external body synchronization.
- `lib/editor/use-card-editor.ts` is the headless React/Tiptap adapter. It owns
  editor creation/destruction, body synchronization, selection/focus state,
  candidate trigger position, composition state, candidate insertion, and
  Undo/Redo commands. It consumes `CardEditorInputModel` and the existing
  `NotesPresentationActions.openCard/updateBody` contract. It has no renderer,
  icon, Tailwind, theme, store, storage, sync, or API dependency.
- `lib/editor/card-link-extension.ts` defines the atomic Tiptap node and its
  NodeView adapter. Visual class names and the instance label resolver are
  injected. The adapter decodes third-party attributes with the #9 codec
  boundary before dispatching a branded `CardId`.
- `components/body-editor-adapter.tsx` connects the application input and
  actions to the headless hook and supplies the chosen presentation adapter.
- `components/body-editor.tsx` is the default renderer. It receives only a
  typed `CardEditorModel` and `CardEditorCommands`; it owns the current popup,
  toolbar, icons, spacing, colors, and copy.

An alternative renderer can provide different content and NodeView classes,
then render the same model/commands. It does not need the notes store,
navigation implementation, IndexedDB, sync protocol, or Tiptap event logic.

## Body and structural contract

Persistence remains an ordered `BodySegment[]` of text and branded card-link
segments. `segmentsToEditorDocument` maps it to a Tiptap document containing a
paragraph, text, hard breaks, and `cardLink` nodes;
`editorDocumentToSegments` validates link attributes and normalizes adjacent
text while preserving whitespace and line breaks. Hash-like text never becomes
a link unless a candidate is explicitly selected.

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
all current labels as plain `cardId/label` records and sorted candidate models;
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

## Identity, external updates, and history

The Tiptap hook’s explicit dependency is `cardId`. A different identity
destroys the old instance and creates a new one from the selected card body,
which establishes a fresh Undo/Redo boundary and resets candidate,
composition, focus, and selection state. The renderer does not use a React
`key` to obtain this behavior.

When the identity is unchanged, a differing application body is applied with
`emitUpdate=false` to avoid a save loop; the editor instance and its history
are retained. A body already equal to the application model is untouched.

## Input and accessibility contract

- Active IME composition records input without opening candidates. The final
  composition event is inspected once composition ends.
- Only typed half-width `#` at an allowed boundary opens candidates. Paste,
  `C#`, `#123` after completion, full-width `＃`, URL fragments, and
  Markdown-style link fragments do not remain triggers and never auto-link.
- ArrowUp/ArrowDown wrap the active candidate, Enter chooses it, and Escape
  closes the list. Mouse/touch choice preserves editor focus so insertion uses
  the original selection.
- Candidate choice replaces only the trigger and inserts an atomic link, then
  closes the suggestion state. Candidate list names and `aria-current` remain
  the renderer contract.
- The toolbar keeps `role=toolbar` and accessible name `編集履歴`; button and
  platform keyboard shortcuts execute the same Tiptap Undo/Redo history and
  expose their current availability.
- A card link uses `role=link`, is focusable, has an action-oriented accessible
  label, and supports click/tap, Enter, and Space.

All application/domain IDs remain branded and all Tiptap attributes remain at
the codec boundary introduced by #9. No body storage, IndexedDB, API, D1, sync,
or navigation format changed in this phase.
