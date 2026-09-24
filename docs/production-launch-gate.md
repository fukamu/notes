# Production Launch Gate

Production Launch Gate separates a production deployment from general
availability. It is an application-wide admission boundary, not a feature
flag. The only authorization rule is:

```text
canAccess = publicAccessEnabled OR userAllowed
```

## Trust boundary

In the production Sites build, the server reads the authenticated identity
only from the platform-supplied `oai-authenticated-user-id` request header. A
browser-supplied user ID, query parameter, JSON field, or frontend state is
never used for authorization. The value is treated as an opaque identifier;
it is not parsed as an email address or an internal Notes Account ID.

`server/launch-gate/http.ts` is the server authorization boundary.
`/api/launch-status` exposes only the current request's booleans. It never
returns the user ID or another user's allowlist state. The legacy sync, Sync
v2, contract checkout, and terms-consent APIs enforce the same decision before
their application handler. Account deletion, privacy requests, cancellation,
public legal pages, and the status endpoint remain reachable so that the gate
cannot prevent cancellation or privacy-rights operations.

All per-user responses are `private, no-store` and vary on the identity header
and Cookie. Configuration read errors, a missing singleton, a malformed
identity header, and D1 errors return `503`; they never enable public access.
An authenticated but unlisted user receives `403` from protected APIs and a
short limited-release screen in the application UI.

After a successful server decision, the current browser tab records only an
admitted boolean in `sessionStorage` so an already-authorized local-first user
can reload while offline. It contains no user ID and expires with the tab.
The existing logout purge clears it in every participating tab before local
content deletion completes.
Changing that browser value can only reveal the already-downloaded app shell;
every network API still makes a fresh server-side D1 decision. An online deny,
invalid response, or server error clears the marker and fails closed.

Development and automated-test builds bypass the production gate in one
central policy. Unknown build modes are treated as production and remain
enforced. The production-like Playwright server applies the gate migration and
uses an isolated allowlisted test identity, so direct API denial and approved
reload behavior are exercised without production state.

## Storage and migration

Migration `drizzle/0017_production_launch_gate.sql` creates:

- `launch_config`: exactly one row (`singleton = 1`) containing
  `public_access_enabled`; the migration inserts `0` (closed).
- `launch_allowed_users`: one opaque Sites user ID per allowed user.

The migration is additive and contains no existing user or content migration.
Apply it through the reviewed Sites/D1 migration procedure before deploying
code that enforces the gate. Never delete the singleton row as an OFF
operation: a missing row is an operational error and intentionally returns
`503`.

## Reviewed production operations

Obtain the exact authenticated user ID from the Sites identity administration
source. Do not substitute an email address, invent an ID, or copy an internal
Notes Account ID. Replace the placeholders below only after the identity and
target D1 database have been verified. Run these statements with the existing
reviewed D1 tooling; this document does not authorize a production operation.

Add one user while keeping the service closed:

```sql
INSERT INTO launch_allowed_users(user_id, created_at)
VALUES ('<exact-sites-authenticated-user-id>', unixepoch() * 1000);
```

Remove one user:

```sql
DELETE FROM launch_allowed_users
WHERE user_id = '<exact-sites-authenticated-user-id>';
```

Open general access explicitly:

```sql
UPDATE launch_config
SET public_access_enabled = 1, updated_at = unixepoch() * 1000
WHERE singleton = 1;
```

Close general access without changing the allowlist:

```sql
UPDATE launch_config
SET public_access_enabled = 0, updated_at = unixepoch() * 1000
WHERE singleton = 1;
```

After every write, verify exactly one configuration row and the intended
allowlist count without exporting user IDs into logs:

```sql
SELECT singleton, public_access_enabled, updated_at FROM launch_config;
SELECT count(*) AS allowed_user_count FROM launch_allowed_users;
```

## Promotion sequence

1. Apply the reviewed migration and verify `public_access_enabled = 0`.
2. Add the verified developer identity and verify an unlisted identity still
   receives the limited-release UI and API `403`.
3. Deploy production code. With the developer identity, test login, logout,
   login again, reload, direct API access, offline/local persistence, sync,
   encryption-backed v2 paths when their real composition is enabled, and
   existing billing/webhook paths in the authorized production test scope.
4. Add verified closed-beta identities one at a time. Removing a row revokes
   gate access on the next request.
5. After the production smoke record and business approval are complete, set
   `public_access_enabled = 1` explicitly. Test both a previously allowlisted
   and an unlisted authenticated user.

Rollback the application deployment without dropping these tables. If access
must be closed, set the flag to `0`; keep the developer allowlist for diagnosis.
