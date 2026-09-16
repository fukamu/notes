# Full-network semantic zoom rollout and rollback

Issue #291 switches the default Connections view from current-card staging to
the complete retained network described by ADR 005. It changes no D1, IndexedDB,
sync, card, or conflict schema. The feature integration branch is
`integration/106-full-network-semantic-zoom`; canonical integration and `main`
remain separate merge decisions.

## Pre-merge evidence

- Unit tests cover complete topology, deterministic layout, routing, semantic
  levels, camera/session restore, bounded accessibility, worker cancellation,
  renderer lifecycle, and legacy/Vault scope isolation.
- Desktop and Pixel 7 E2E cover all-card/all-link counts, disconnected and
  isolated cards, self/mutual links, pointer/pinch/keyboard interaction,
  Back/Forward, offline restore, logout worker purge, explicit failure/retry,
  and a 10,000-card graph without per-card DOM.
- `git diff --check`, `npm run verify`, and required GitHub Actions must pass on
  the work PR and again after merge to the feature integration branch.

## Manual canary checks

1. Open `つながり` and confirm the summary card/link counts match the local
   Vault, including isolated cards and disconnected groups.
2. Pan and zoom from the fit-all view. Confirm the overview stays complete and
   card labels appear only after close zoom.
3. Use `全体`, `現在地`, pointer/touch, N/E/L/C, modified arrows, Enter, and the
   browser Back button. Card navigation must not reset the same-session camera.
4. Toggle offline mode after offline preparation and reload a Connections deep
   link. Then sign out and confirm a later session does not recover the old
   camera, worker, cache, or content.
5. Confirm there is no search field, staged-card count, or “さらに表示” action.

## Rollback rehearsal

The #291 merge commit is the cutover boundary. In a temporary branch/worktree
created from the feature integration tip, revert that single merge commit and
run the compatibility checks. The resulting tree must restore the pre-cutover
default without touching storage or migrations. Delete the temporary rehearsal
branch/worktree after recording its verification; never force-push or rewrite
the feature integration branch.

Before the feature roll-up reaches canonical integration, rollback is simply to
omit or revert that roll-up. After roll-up but before `main`, revert the roll-up
merge. A future `main` rollback requires separate explicit approval. No Sites
deployment or production data operation is part of Issue #291.

## Residual risks

Real hardware GPU throughput, mobile thermal behavior, browser-specific WebGL
loss, and extremely dense first-raster latency require deployment canary
observation. A supported-browser failure must remain explicit and retryable; it
must never silently reinstate graph sampling or the old 256-card limit.
