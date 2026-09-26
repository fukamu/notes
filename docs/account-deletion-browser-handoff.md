# Account deletion browser handoff core

The browser handoff remains TypeScript. References below to the former
TypeScript server, Sites environment, or D1 persistence are historical
compatibility context; the server saga and HTTP contracts are now Go with
PostgreSQL persistence and remain fail closed until explicitly composed.

Issue #175 defines the pure browser handoff state machine and runner between the
server boundary from #174 and the existing crash-resumable logout purge from
#148. Issue #183 supplies browser persistence, HTTP, entropy, and clock adapters.
Issue #184 adds an optional authenticated UI/reload boundary and browser E2E
coverage. None of these Issues deploys a route or performs a production
deletion.

## Durable order and crash recovery

The runner accepts Account/Vault/Session generation, clock, idempotency key,
progress storage, server and logout-purge ports as injected values. It commits
an `account-deletion-handoff/v1` marker before sending the authenticated start
request. The marker contains the generation, revision, idempotency key, current
phase, and latest continuation status. It contains no note content, email,
payment data, or provider identifier.

The ordered handoff is:

1. persist `starting` before the start request;
2. persist the returned continuation capability as `revoke-pending`;
3. send one status request so the server executes or confirms the mandatory
   all-session revocation step;
4. persist `purge-pending`, then call the existing verified logout-purge runner;
5. persist `server-pending` and advance at most one remaining server step for
   each explicit status action;
6. conditionally clear the marker only after a terminal server response.

A `retry-wait` response while revocation is pending keeps the handoff in that
phase and leaves local content retained but inaccessible. Local purge starts
only after a later response confirms that the saga advanced beyond that retry.

A crash before a response is persisted retries start with the same idempotency
key or retries status with the previous continuation sequence. The bounded
server replay contract from #174 returns the current capability without
repeating an effect. A crash during local deletion re-enters the existing
logout purge state machine. If its marker was already cleared, repeating its
idempotent verified targets is safer than declaring the account handoff done.

The UI reducer is also pure. It distinguishes content retained during a
revocation retry from content deleted after local purge, preserves typed
failure/retry information, and does not infer completion from an absent or
malformed external value.

## Browser adapters

The marker is stored in the non-content `fukamu-notes:control:v1` IndexedDB.
Its additive schema version 2 preserves the existing `logout-purge` store and
adds a separate `account-deletion-handoff` store. Both stores use transactional
compare-and-swap writes. A corrupt or unknown-version marker is returned to the
runner for fail-closed handling instead of being cleared or guessed.

The HTTP adapter sends only `idempotencyKey` or `continuationToken`, uses
same-origin credentials, refuses redirects, disables caching, and decodes every
success body from `unknown`. AccountId and VaultId are never accepted from UI
or request body. Web Crypto supplies 256 random bits for the unpadded base64url
idempotency key, while clock and fetch remain injected for deterministic tests.

The browser composition reuses the existing `BrowserLogoutPurgeService`; it
does not duplicate cache, Service Worker, graph worker, tab-lock, or Vault
database deletion. `LegacyNotesApp` still does not construct this composition,
so local development and the current test Sites environment remain free of
authentication, billing, and deletion requirements unless explicitly composed.

## UI and access behavior

`AccountDeletionBoundary` checks durable state before rendering
`SessionNotesApp`, entering its runtime fence, or constructing Notes runtime
ports. It wraps the authenticated and anonymous branches when explicitly
injected, so a reload after server session revocation continues the stored
handoff instead of showing anonymous content or starting Notes state.

An authenticated user must open an alert dialog and explicitly confirm the
irreversible operation. Status distinguishes data retained while revocation is
waiting from data deleted after local purge. Pending and failed states never
render Notes. Server progress is user-driven and performs one HTTP step per
action; `retryAt` prevents an early request without adding a client polling
timeout. The recovery path does not consult content entitlement, matching the
server policy that keeps deletion available to payment-locked accounts.

The browser E2E starts the production browser composition with test-only HTTP
responses, uses two tabs, gives two Vaults the same CardId, and verifies that
session revocation handoff, local database/cache/worker deletion, reload,
back/forward navigation, and continuation completion cannot resurrect the
deleted Vault or affect the other Vault.

## Security and rollback

The continuation capability must survive session revocation, so its browser
storage treats it as a high-entropy, owner-bound, sequence-rotated,
expiry-bound capability, omits it from URLs and logs, and removes it only with
the terminal marker's conditional clear. Same-origin script can read IndexedDB;
preventing script injection remains a required application security control.

Rolling back the visible composition is safe only if the durable adapter and
runner remain able to detect and finish existing markers. A deployed rollback
must not ignore or delete either account-deletion or logout markers. This
change performs no production migration, deletion, email, payment, deployment,
or `main` update.
