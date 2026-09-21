# Shared design-token visual evidence

These screenshots compare the exact pre-adoption integration tree
`b80075b87a32f80701b28b517c619fbec9937ce7` with the Issue #394 adoption using
the same deterministic fixture and browser conditions.

## Conditions

- Ubuntu 24.04.4 LTS x86_64
- repository Playwright 1.63.0 / bundled Chromium 153.0.8010.12
- user agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36`
- Light mode, `lang=ja`, system-font fallback only
- desktop viewport 1440×900 at DPR 1
- mobile project with Pixel 7 user agent, viewport 412×915 at DPR 2.625
- 13 long-Japanese cards in one cyclic graph, one visible conflict notice,
  history/navigation, primary actions, focus semantics, and Canvas edges

The Windows/Android product baseline was not available on this host and is not
claimed as tested.

## Comparison

| State                   | Before                                                                         | After                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Desktop card / conflict | [`before-desktop-light.png`](before-desktop-light.png)                         | [`after-desktop-light.png`](after-desktop-light.png)                         |
| Mobile card / conflict  | [`before-mobile-light.png`](before-mobile-light.png)                           | [`after-mobile-light.png`](after-mobile-light.png)                           |
| Desktop connections     | [`before-connections-desktop-light.png`](before-connections-desktop-light.png) | [`after-connections-desktop-light.png`](after-connections-desktop-light.png) |
| Mobile connections      | [`before-connections-mobile-light.png`](before-connections-mobile-light.png)   | [`after-connections-mobile-light.png`](after-connections-mobile-light.png)   |

The expected palette and body fallback-stack changes are visible. Warm canvas,
paper rules, link capsules, shadows, Mincho headings, line wrapping boundaries,
navigation placement, graph camera/geometry, grid density, node layout, and
Canvas backing dimensions remain stable. The automated runtime contract also
checks actual computed values and painted Canvas pixels; screenshots alone are
not used as the token contract.
