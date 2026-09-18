# Browser logout purge

Issue #148 completes the local-device half of logout. It composes the durable
state machine from #144 and the runtime locks from #147 with browser adapters;
it does not revoke a server session or delete server-side account data.

## Durable marker and ordered effects

The non-content `logout-purge/v1` marker lives in
`fukamu-notes:control:v1`, outside every Vault database. Control database
schema version 2 additively introduces the account-deletion handoff store while
preserving this logout store and marker. Reads and
compare-and-swap writes use one IndexedDB transaction, so another tab cannot
replace a newer revision. Missing progress allows runtime entry; corrupt,
unknown-version, or unavailable progress continues to fail closed.

After acquiring the exclusive purge-owner lock, the runner persists
`target-started`, performs exactly the target selected by the pure state
machine, and then persists completion or a typed failure. Effects remain in
this order:

1. establish the durable runtime fence;
2. quiesce every shared runtime lock;
3. close the scope-bound Vault database connection;
4. terminate the graph worker and reject its in-flight work;
5. request and verify Service Worker cache deletion;
6. delete the trusted Vault database;
7. verify the connection, worker, cache, and database are absent.

Only the final verification transition can conditionally remove the marker.
Blocked database deletion, cache acknowledgement timeout, missing browser
capability, adapter error, and failed verification remain retryable marker
states. A reload converts a persisted running target to `interrupted`,
re-establishes peer quiescence, and repeats only that target and later targets.

## Isolation and compatibility

The Vault database name is derived only from the decoded session generation.
Deleting one Vault therefore leaves another Vault intact even when both use the
same CardId. The cache adapter accepts only the exact purge acknowledgement and
then lists CacheStorage again. IndexedDB absence is checked with
`indexedDB.databases()` so verification cannot recreate the deleted database.

`createBrowserLogoutPurgeService` exposes the authenticated runtime fence and
purge runner as one explicit composition. `LegacyNotesApp` does not construct
this service, so local development remains authentication- and billing-free
and does not delete data unless a caller explicitly invokes the logout flow.

Browser E2E bundles this production composition into a test-only in-page
harness; no test route or production fake is shipped. It exercises two tabs,
Web Locks/BroadcastChannel, Service Worker cache deletion, Vault isolation,
worker reset, back/forward navigation, and a subsequent Vault login.

## Rollback and remaining server work

This change has no server schema migration and no production data operation.
A rollback must not ship an authenticated logout path that clears or ignores a
pending marker; retaining the marker and blocking the runtime is safer. Server
session revocation and account deletion server effects remain owned by #123.
The browser handoff that reuses this purge is described in
[Account deletion browser handoff](account-deletion-browser-handoff.md).

This work is not deployed to production and does not update `main`.
