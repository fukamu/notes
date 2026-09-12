# UI/UX redesign design exploration

Parent issue: [#72](https://github.com/fukamu/notes/issues/72)
Design issue: [#75](https://github.com/fukamu/notes/issues/75)
Integration branch: `redesign/72-integration`
Work branch: `redesign/75-design`
Branch point: `006a24037ad60af38559f5935d430b725da3c210`
Figma file: <https://www.figma.com/design/zVb30VcGJ02JYMmZwTcsK4>
Figma page: `Issue 75 Design Exploration`

## Design principles

1. Writing stays primary. FUKAMU Notes is for forming one thought per card, not
   managing a dashboard.
2. Context should be near the card, but not louder than the card.
3. History and connections are thinking tools, not hidden secondary decoration.
4. State should be legible at a glance: saved, syncing, offline, failed, and
   conflict states must not depend on memory.
5. The redesign must preserve current behavior: local-first autosave, explicit
   one-way links, URL contracts, conflict resolution, offline behavior,
   keyboard/touch graph controls, and presentation/core separation.
6. Narrow screens need a real layout model, not only compressed desktop spacing.

## Evaluation criteria

| Criterion                    | Meaning                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Product fit                  | Supports single-user local-first Zettelkasten without adding search/tag/dashboard semantics. |
| Primary task speed           | Makes create, write, link, browse, and map navigation easier to find and complete.           |
| Information clarity          | Makes current card, display ID, status, context, and mode clear without overexplaining.      |
| State clarity                | Handles empty, loading, offline, sync failed, and conflict states visibly.                   |
| Accessibility/responsive fit | Keeps labels, focus, keyboard/touch operation, and small-width ergonomics intact.            |
| Feature completeness         | Keeps all existing functions reachable.                                                      |
| Implementation complexity    | Fits the existing presentation contracts without domain/storage/API changes.                 |

## Figma artifacts

| Artifact                             | Node   |
| ------------------------------------ | ------ |
| Exploration overview                 | `2:3`  |
| Option A Quiet writing workbench     | `2:6`  |
| Option B Split stack + map workbench | `2:25` |
| Option C Current-card orbit          | `2:61` |
| Selected direction record            | `2:81` |

## Option A: Quiet writing workbench

The current card remains the dominant surface. A compact context panel sits near
the card and can carry recent cards, sync status, conflict prompts, and entry
points into history/connections.

Strengths:

- Best fit for the product's writing-first concept.
- Lower cognitive load than simultaneous multi-pane views.
- Maps cleanly to current presentation contracts.
- Responsive model is straightforward: card first, context as a bottom or
  collapsible panel, navigation as compact mode controls.

Risks:

- History and connections may still feel secondary if the context panel is too
  quiet.
- Large desktop width can remain underused unless the context panel provides
  genuinely useful nearby information.

## Option B: Split stack and map workbench

History, editor, and a small map are visible together. This treats FUKAMU Notes
as a navigable workbench for moving quickly between cards and relationships.

Strengths:

- Fastest access to history and map context.
- Makes the relationship between browse/write/map explicit.
- Strong for users reviewing many existing cards.

Risks:

- Can imply a dashboard or knowledge-base manager, which conflicts with the
  product's intentionally small feature set.
- More responsive complexity and more visual competition with writing.
- More likely to create implementation churn in history/connections layout.

## Option C: Current-card orbit

The current card is centered, with temporal context on the left and link context
on the right.

Strengths:

- Strong conceptual model: the current card is the center of thinking.
- Shows history and links as context rather than separate destinations.
- Could make current-card context feel alive.

Risks:

- More novel interaction model; harder to validate without user testing.
- Could blur the distinction between explicit outgoing links and unsupported
  backlink-like context.
- Higher risk of responsive and accessibility edge cases.

## Selected direction

Selected: **Option A, Quiet writing workbench, with faster context access from
Option B**.

Rationale:

- FUKAMU Notes is not a dashboard. The safest product fit is to protect the
  quiet writing center.
- The redesign should still address the current distance between writing,
  history, connections, and state. A compact workbench context panel can bring
  those controls closer without permanently splitting attention.
- This direction preserves all current behavior and is the lowest-risk path
  through the existing `NotesPresentationModel`, editor renderer, connections
  renderer, and visual tokens.

Tradeoffs:

- Less simultaneous comparison than Option B.
- Less distinctive spatial metaphor than Option C.
- The context panel must earn its space with useful status and nearby actions,
  otherwise the design may become the current paper-sheet layout with a renamed
  sidebar.

## Selected information architecture

- Top workbar:
  - product identity
  - create card
  - global save/sync state when not card-specific
  - compact mode switch: card, history, connections
- Main card workspace:
  - display ID and local status
  - conflict notice when present
  - title and body editor
  - editor-local undo/redo and link candidate interaction
- Context panel:
  - recent/neighboring cards from history
  - current-card actions and graph shortcuts
  - retry/sync failure action when relevant
  - on narrow screens, becomes a lower panel or reachable mode tray
- History mode:
  - retains full card stack and current-card centering
  - uses selected direction tokens and denser scan layout
- Connections mode:
  - retains the complete graph and controls
  - uses a clearer map header/control grouping, not a decorative dashboard

## Feature matrix mapping

| Existing feature      | Selected-direction entry                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Create card           | Top workbar primary action and empty-state action.                                        |
| Autosave status       | Visible near card identity; retry action in context panel when retryable.                 |
| Title/body editing    | Main workspace remains the first and largest surface.                                     |
| Card link suggestions | Stays in editor flow; visual treatment can be updated with tokens.                        |
| Undo/redo             | Editor-local toolbar near the body, preferably compact icon buttons with labels/tooltips. |
| Conflict resolution   | Inline alert above editor, plus context panel status marker if needed.                    |
| History               | Mode switch and context-panel neighboring cards; full history mode remains.               |
| Connections           | Mode switch and context-panel shortcut; full graph mode remains with all controls.        |
| URL/history/offline   | No IA change requires route or persistence changes.                                       |

## Implementation implications

- Start with shared visual tokens and layout primitives in presentation CSS.
- Implement the card workspace and context panel first because it exercises the
  selected IA.
- Keep `NotesPresentationModel` as the main boundary; do not pull storage/sync
  data into presentation components.
- Reuse lucide icons for compact controls and preserve accessible names.
- Keep structural classes for editor and connections behavior separate from new
  visual theme classes.

## Validation notes

- This is a design rationale and implementation hypothesis, not user-tested
  evidence.
- Figma artifacts are editable frames, not screenshots pasted as final design.
- No production code changed in this issue.
