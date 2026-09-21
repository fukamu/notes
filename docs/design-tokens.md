# Shared design tokens

FUKAMU Notes adopts the fixed FUKAMU shared design-token contract for common
Light-mode semantics. Git remains the source of truth; the checked-in bundle is
an immutable consumer copy, not a second editable source.

## Fixed contract and provenance

| Item                          | Fixed value                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| Contract version              | `0.1.0`                                                            |
| Canonical repository          | `fukamu/design-tokens`                                             |
| Canonical source commit (S)   | `b57d1531f26c14e2f1f82440b9f150a3a185bd16`                         |
| Generated artifact commit (A) | `5fcb06269607fe3b21184000d286cd7810aa1f47`                         |
| Manifest SHA-256              | `5c7e8e90873e5581fb70e7676cb5935092fa3a517f46b3a98360c411d7633915` |
| Notes branch point            | `b80075b87a32f80701b28b517c619fbec9937ce7`                         |

The complete eight-file text bundle lives at
`vendor/fukamu-design-tokens/0.1.0/`. `manifest.json` fixes the version, source
commit, seven payload paths, and every payload hash. The contract test rejects
missing, extra, mixed, symlinked, or modified payloads.

CSS is loaded in this order:

1. generated shared `css/tokens.css`;
2. Notes compatibility aliases in `app/globals.css`;
3. Notes component and theme rules.

Consumer code only uses public semantic `--fukamu-*` aliases. Private
`--fukamu-primitive-*` variables must not be referenced from Notes mappings.

The formatter excludes only `vendor/fukamu-design-tokens/**` because formatting
generated payloads would change the upstream-owned bytes and invalidate their
manifest hashes. The focused contract test is the replacement guard: it checks
the complete file set, manifest, and every payload hash, and it prevents this
exception from broadening to all `vendor/**`. Remove the formatter exception if
an approved future registry distribution stops checking generated payloads into
the repository; do not remove the byte/hash guard while a vendored version is
still consumed.

## Light semantic mapping

| Notes compatibility role                                    | Shared public token                            |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `--font-body`                                               | `--fukamu-font-family-body-ja`                 |
| `--foreground`, `--card-foreground`, `--popover-foreground` | `--fukamu-color-text-primary`                  |
| `--muted-foreground`                                        | `--fukamu-color-text-secondary`                |
| `--card`, `--popover`                                       | `--fukamu-color-surface-default`               |
| `--border`, `--input`                                       | `--fukamu-color-border-default`                |
| root/action `--primary`                                     | `--fukamu-color-action-primary`                |
| `--primary-hover`                                           | `--fukamu-color-action-primary-hover`          |
| `--primary-foreground`                                      | `--fukamu-color-action-on-primary`             |
| `--ring`                                                    | `--fukamu-color-focus-ring`                    |
| `--destructive`                                             | `--fukamu-color-status-danger-foreground`      |
| `--warning-bg`, `--warning-border`, `--warning-foreground`  | shared warning surface, border, and foreground |
| `--radius`                                                  | `--fukamu-radius-lg`                           |

Tailwind font weights, body/small sizes, the quarter-rem spacing basis, default
border width, and `sm` through `xl`/pill radii are bridged to the corresponding
public shared tokens. Existing `rounded-2xl` surfaces resolve to the shared
`radius.xl` value rather than an unrelated Tailwind default.

`--primary` has two intentionally separate scopes. Root UI actions use shared
`color.action.primary`; `.connections-viewport` overrides the compatibility
name with shared `color.accent`. The existing Canvas adapter continues to read
`--card`, `--border`, and `--primary` through `getComputedStyle`, so DOM nodes,
edges, the current-node halo, and Canvas receive the same scoped values without
changing rendering or cache logic.

Warning muted and preview text remain Notes-owned translucent sub-roles, but
are derived from shared warning foreground rather than independent literals.
The translucent conflict-option layer remains Notes-owned.

## Notes-owned values

The following remain product-owned and are not aliases of the common contract:

- warm canvas background;
- decorative secondary, muted, and accent surfaces;
- link capsule, paper rule, graph grid, and all shadows;
- Mincho heading stack and card prose metrics;
- graph, node, edge, camera, raster, history, editor, responsive, and layout
  geometry;
- inactive `.dark` values, PWA manifest colors, and favicon colors.

Contract `0.1.0` is Light only. This adoption neither enables a theme switcher
nor claims that Notes dark values are synchronized. The body stack remains
system-font-first and does not add a Web Font or CDN request.

## Verification

The focused contract test verifies provenance, the complete file set, every
hash, import order, public-only aliases, Tailwind bridges, action/graph scope
separation, Canvas compatibility reads, Notes-owned residuals, and inactive
dark definitions. Delivery additionally requires `git diff --check`, the full
`npm run verify`, exact-head GitHub Quality, and fixed desktop/mobile browser
evidence for editor/card, history/navigation, conflict, action/focus, and
connections states.

The adoption evidence uses Ubuntu 24.04.4 LTS x86_64, Node 24.21.0, npm
11.19.0, repository Playwright 1.63.0, and bundled Chromium 153.0.8010.12.
The same 13-card cyclic fixture and conflict notice were captured before and
after the migration at desktop 1440×900 and mobile Pixel 7-equivalent 412×915.
The committed comparison set is documented in
[`docs/screenshots/design-tokens/README.md`](screenshots/design-tokens/README.md).

Observed intentional changes are the shared primary/secondary text,
white default card, blue default border, Deep Blue action/hover, Accent Blue
focus/graph, shared warning palette, body fallback stack, and small shared
radius bridge adjustments. Warm canvas, link styling, paper rule, grid,
shadows, Mincho headings, prose metrics, layout, and graph geometry are
unchanged. The runtime contract test verifies 13 nodes/13 edges, non-empty
Canvas edge pixels, exact DOM/Canvas computed-token agreement, desktop hover,
mobile wrapping without page overflow, history navigation, conflict states,
and Canvas repaint after the test fixture toggles the root class. That class
toggle is verification-only; the product still has no active theme UI.

The product baseline is Windows and Android. Evidence collected on Ubuntu is
recorded as Ubuntu evidence and must not be described as Windows or Android
validation.

## Updating and rollback

Never overwrite `0.1.0`. For a future approved contract, fix a new source
revision, generated artifact revision, version, and manifest hash; verify the
upstream bundle; copy all files into a new version directory; update the CSS
import, aliases, tests, and this record atomically; then compare the same visual
fixtures. Do not use an archive, registry, CDN, floating ref, neighboring
`file:` dependency, or link.

Rollback is atomic: revert the Notes adoption PR so the compatibility mapping
and complete version directory return together. Never mix files from different
source revisions or contract versions. Canvas geometry, sync, storage, editor,
service worker, and production data require no rollback operation because this
change does not modify them.
