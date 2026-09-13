# Identity, session, and VaultContext boundary

Issue #110 introduces provider-neutral identity and session contracts without
connecting Google, email, billing, or a production session database.

## Ownership source

`AccountId`, `VaultId`, `SessionId`, `IdentityId`, and `SessionEpoch` are
separate branded values decoded at boundaries. A `VaultContext` is produced
only after the presented `__Host-fukamu_session` token resolves to a decoded,
active, unexpired session. Request bodies are never inspected to choose an
account or vault.

Production session storage must hash presented 256-bit tokens before lookup.
The in-memory resolver in this Issue is a fake test adapter and must not be
used as a production token store.

## Session lifecycle

The pure session core models active and revoked records. Authorization returns
anonymous, denied, or authenticated decisions. Rotation requires a fresh
session ID, a fresh bearer token, and exactly the next epoch; it revokes the
previous record so a fixed or replayed session cannot remain active. Logout/security revocation is
idempotent. Operations compare their captured VaultContext with the current
record and reject session, account, vault, or epoch mismatches.

Clocks and token/UUID generation remain outside the core.

## Cookie and CSRF policy

The authenticated session cookie is named `__Host-fukamu_session` and is
always `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`, with no Domain
attribute. Clearing uses the same scope and `Max-Age=0`.

Unsafe HTTP methods require both an exact configured `Origin` and
`Sec-Fetch-Site: same-origin`. Missing metadata, sibling-subdomain
`same-site`, cross-site, or malformed origins fail closed before session
lookup. GET, HEAD, and OPTIONS are classified as safe methods; their handlers
must remain read-only.

## Client initialization gate

`SessionNotesApp` returns the unauthenticated view before constructing runtime
ports. For authenticated access it derives a vault scope, constructs the
runtime behind a session/epoch React key, and checks that the returned
repository/transport scope matches the VaultContext before mounting
`NotesProvider`. This prevents IndexedDB, sync, or Service Worker preparation
from starting for anonymous access.

The current route deliberately mounts `LegacyNotesApp` as an explicit local
compatibility harness. A vault-scoped IndexedDB repository now exists, but it
is not mounted in the route. The Provider now rejects stale load/save/sync
completion by trusted scope and operation epoch; crash-resumable logout purge
decisions now exist in #144, while multi-tab and browser deletion composition
remain in #147 and #148. This preserves current local development and E2E
behavior without Google, email, billing, or production configuration; it is
not the production public-service composition. See
[Notes operation lifecycle boundary](notes-operation-lifecycle.md).

## Migration and rollback

This Issue creates no schema and migrates no data. Reverting the Issue removes
only new contracts, fake adapters, and the composition gate. No production
session store, secret, email, payment, or deployment is created. `main` remains
unchanged.
