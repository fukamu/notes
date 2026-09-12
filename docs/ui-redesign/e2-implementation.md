# E2 implementation and release record

Parent: [#83](https://github.com/fukamu/notes/issues/83)

Acceptance and Sites deployment: [#99](https://github.com/fukamu/notes/issues/99)

Figma E2 source: <https://www.figma.com/design/UCfz16t3ZU7yUYKBHNiz8r?node-id=34-101>

Target: `redesign/83/integration`

Issue #99 branch point: `ed79c8774fdf7e45d59067332155d3ea9f413015`

`main`: unchanged and not a target of this delivery.

## Source-to-runtime traceability

| Figma node         | Contract                                                                                | Runtime implementation                                                                              | Delivery      |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| `34:109`           | E2 colour, type, spacing, radius, and responsive foundations                            | `app/globals.css`                                                                                   | #96, #97, #98 |
| `34:111`, `34:112` | Desktop/mobile editor, header, status, and body-link index                              | `components/notes-presentation.tsx`, `components/body-editor.tsx`, `lib/application/view-models.ts` | #96 / PR #100 |
| `34:113`           | Descending ruled history with a textual current marker                                  | `components/history-view.tsx`                                                                       | #97 / PR #101 |
| `34:114`, `42:182` | Directed all-card map, 216 × 80 nodes, textual current marker, and exact toolbar labels | `components/connections-view.tsx`, `components/connections-presentation.ts`                         | #98 / PR #102 |
| `34:115`           | Neutral conflict explanation and equal A/B resolution actions                           | `components/conflict-notice.tsx`                                                                    | #97 / PR #101 |

The editor's body-link index is derived by the pure
`selectCardEditorOutgoingLinks` selector. It includes only valid explicit links
to cards present on the device, preserves first appearance order, deduplicates
targets, and disappears when empty or at mobile width. It does not add
backlinks, search, recommendations, or a second navigation model.

## Acceptance boundary

Automated checks cover the existing offline, sync, editor, URL, history,
conflict, graph, camera, keyboard, and touch contracts on desktop and Pixel
7-class mobile projects. A focused 320 px acceptance check additionally keeps
the editor, history, and connections views within the document width, hides the
desktop-only body-link index, and keeps every connections toolbar control inside
the graph viewport.

The deployment artifact must be packaged from the exact verified integration
commit. Publishing may update only the existing Sites project and must retain
its current owner-private access. This delivery does not authorise a GitHub
`main` update, access changes, production D1 operations, or custom-domain
changes.
