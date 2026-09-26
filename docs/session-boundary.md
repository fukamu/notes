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

Migration Issue #422 adds the equivalent Go boundary and a PostgreSQL adapter.
The adapter persists only canonical SHA-256 token digests, validates every row
on read, and derives VaultContext only after cookie, CSRF, active-state,
expiry, and scope checks. Issue #511 connects that resolver only for the exact
prepared local-fixture generation. It does not add login, callback, rotation,
logout, OIDC, OTP, or production session issuance routes.

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
ports. For authenticated access it derives a vault scope, enters the injected
logout runtime fence, then constructs the runtime behind a session/epoch React
key. It checks that the returned repository/transport scope matches the
VaultContext before mounting `NotesProvider`. This prevents IndexedDB, sync, or
Service Worker preparation from starting for anonymous or purge-blocked access.

When the optional account-deletion runner is supplied, its durable handoff
boundary wraps both authenticated and anonymous branches. It checks progress
before the runtime fence is entered and therefore resumes local purge even
after the server has revoked the browser session. The legacy route does not
supply this runner. See
[Account deletion browser handoff](account-deletion-browser-handoff.md).

The current notes route mounts `AuthenticatedNotesBootstrap`. It calls the
local-only Go `GET /api/session-context`, strictly decodes exactly the four
VaultContext fields, and passes authenticated access to `SessionNotesApp`.
Until that succeeds it does not construct the Vault IndexedDB repository, Sync
transport, Service Worker preparation, or logout fence. The endpoint is
private/no-store, never returns the bearer token, and is closed outside the
exact local fixture. An offline reload therefore fails closed until the server
can validate the cookie again.

The authenticated composition requires the browser logout runtime fence,
stops operations in the layout phase, and uses the typed
BroadcastChannel/Web Locks coordination from #147. Actual browser deletion
remains #148. `LegacyNotesApp` remains compatibility/test code but is not a
route fallback. This connects local/E2E behavior without Google, email, Stripe,
or production configuration; it is not the production public-service
composition. See
[Notes operation lifecycle boundary](notes-operation-lifecycle.md).

## Migration and rollback

The original TypeScript Issue created no schema or production data. The Go
migration reuses the control-plane tables created by T03 and adds no migration.
Rolling back #511 removes the local session endpoint/bootstrap connection but
must preserve any disposable fixture journal, ciphertext, quota, and key state
until the complete local graph is stopped. No production session, secret,
email, payment, provider, or deployment is created.
