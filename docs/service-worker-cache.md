# Service Worker cache policy

The Service Worker cache contains only the non-personal app shell and explicit
static build resources. It is not a content store and must not become an
authentication, billing, or API response cache.

## Cache boundary

`service-worker/sw.ts` decides cache behavior from a typed pure policy before
calling `fetch` or CacheStorage.

| Request                                                                                              | Policy                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /`, canonical card/history/connections navigation                                               | Network response; cached `/` shell only as the offline fallback |
| `GET /manifest.webmanifest`, `/favicon.svg`, `/_next/static/**` without query or hash                | Static cache                                                    |
| API, auth/OAuth callback, billing/account, query-bearing, cross-origin, non-GET, and all other paths | Network only                                                    |

The `/` response is therefore required to stay non-personalized. Personal
content continues to come from the active vault's IndexedDB replica after the
application starts.

## Logout and migration

`OfflineAppPort.purge()` sends `LOGOUT_CACHE_PURGE`. The worker deletes every
cache in the `fukamu-notes-` namespace, verifies that none remain, and only then
returns the typed `LOGOUT_CACHE_PURGE_RESULT/purged` acknowledgement. A delete
error or acknowledgement timeout is a failure, not successful logout cleanup.
Issue #148 composes this protocol with vault-scoped IndexedDB and worker
cleanup after #147 establishes multi-tab quiescence. The page adapter accepts
only the exact acknowledgement and lists CacheStorage again before allowing
the pure purge state machine to advance.

Activation of `fukamu-notes-static-v3` removes older FUKAMU cache versions but
does not touch another application's caches. This is the forward migration from
the unsafe v2 policy.

## Rollback

Do not roll back to the v2 worker because it cached broad same-origin GET
responses. If v3 causes a production defect, ship a forward fix under a new
cache version so activation still removes v2 and v3 data. Server and application
features must remain usable without Service Worker support; disabling
registration is safer than restoring the broad cache policy.

This policy has not been deployed to production, and this branch does not
update `main`.
