# Connections map visual evidence

The eight images use the same local 13-card fixture and fit-to-bounds camera.
`before-*` records the Issue #45 branch point; `after-*` records the Issue #46
quadratic-center-line renderer. Desktop uses a 1440 × 900 viewport override and
mobile uses 412 × 915. The in-app Browser screenshot surface excludes its own
scrollbar gutter, so the stored after-image pixel dimensions are 1425 × 891 and
397 × 882. No application source or persisted card data is changed to create the
dark captures.

Visual review checks:

- the three directed links visibly use real rounded corners and retain arrowheads;
- the card-color halo separates the center line from the grid in light and dark;
- endpoints meet the source/target ports without section gaps;
- desktop has a wide map viewport, and the mobile map does not overlap the fixed
  bottom navigation;
- clipped mobile content remains reachable by the map camera rather than document
  scrolling.
