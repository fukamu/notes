# Connections map visual evidence

The eight images use the same local 13-card fixture and fit-to-bounds camera.
`before-*` records the Issue #45 branch point; `after-*` records the Issue #46
quadratic-center-line renderer. Desktop uses a 1440 × 900 viewport override and
mobile uses 412 × 915. The in-app Browser screenshot surface excludes its own
scrollbar gutter, so the stored after-image pixel dimensions are 1425 × 891 and
397 × 882. No application source or persisted card data is changed to create the
dark captures.

Issue #55 adds current-code light captures at
`follow-up-desktop-light.png` (1440 × 900 viewport; 1425 × 891 captured surface)
and `follow-up-mobile-light.png` (Pixel 7-equivalent 412 × 915). They verify the
unchanged map geometry, toolbar wrapping, bottom-navigation boundary, and zoom
output after the 10–200% camera change. The production visual classes and color
tokens have no Issue #55 diff, so the existing `after-*-dark.png` captures remain
the dark-theme comparison; E2E additionally checks that the changed native
disabled state has `pointer-events: none` and computed opacity 0.35 at both
boundaries.

Visual review checks:

- the three directed links visibly use real rounded corners and retain arrowheads;
- the card-color halo separates the center line from the grid in light and dark;
- endpoints meet the source/target ports without section gaps;
- desktop has a wide map viewport, and the mobile map does not overlap the fixed
  bottom navigation;
- clipped mobile content remains reachable by the map camera rather than document
  scrolling.
- Issue #55 leaves touch ownership scoped to the map (`touch-action: none`) while
  the surrounding heading remains `touch-action: auto`.
