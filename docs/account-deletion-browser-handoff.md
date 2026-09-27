# Account deletion browser handoff core

The browser handoff remains TypeScript. References below to the former
TypeScript server, Sites environment, or D1 persistence are historical
compatibility context; the server saga and HTTP contracts are now Go with
PostgreSQL persistence and are composed only by the explicit destructive
disposable local fixture.

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

The connected exact-fixture handoff is:

1. persist `starting` before the start request;
2. persist the returned continuation capability as `revoke-pending`;
3. prepare the existing logout-purge marker and cross-tab coordination, which
   immediately quiesces existing peers and blocks newly opened Notes runtimes
   but does not yet run a deletion target;
4. send one status request so the server executes or confirms the mandatory
   all-session revocation step;
5. persist `purge-pending`, then call the existing verified logout-purge runner;
6. persist `server-pending` and advance at most one remaining server step for
   each explicit status action;
7. conditionally clear the marker only after a terminal server response.

Logout preparation occurs only after Start has been durably accepted. A policy
rejection therefore cannot leave the browser durably quiesced. A crash in
`starting` replays Start with the same idempotency key and then prepares logout;
a crash in `revoke-pending` idempotently prepares the same logout generation
before Resume. Preparation failure prevents the first Resume.

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

The browser composition reuses one `BrowserLogoutPurgeService` instance for the
runtime fence, Account deletion runner, cache, Service Worker, graph worker,
tab coordination, and Vault database deletion. It does not duplicate those
ports. The live local-fixture route now supplies this runner and deletion UI;
default/production or an undecided fixture still has no server route and fails
closed.

The authenticated session-context response carries a strict boolean discovery
bit derived from whether that complete deletion runtime is mounted. Recovery
of an existing marker never depends on the bit. A new deletion trigger is
shown only when it is true, so an undecided fixture cannot persist a `starting`
marker for a route that will reject admission and then block ordinary Notes.

## UI and access behavior

`AccountDeletionBoundary` is the client composition root outside both
`ProductionLaunchGate` and authenticated-session bootstrap. It checks durable
state before requesting launch/session data, rendering `SessionNotesApp`,
entering its runtime fence, or constructing Notes runtime ports. A reload after
server session revocation or a launch 403/503 therefore continues the stored
handoff instead of showing anonymous content or starting Notes state. Only the
idle/no-marker child mounts launch, session, and Notes runtime.

An authenticated user must open an alert dialog and explicitly confirm the
irreversible operation. Status distinguishes data retained while revocation is
waiting from data deleted after local purge. Pending and failed states never
render Notes. Server progress is user-driven and performs one HTTP step per
action; `retryAt` prevents an early request without adding a client polling
timeout. The recovery path does not consult content entitlement, matching the
server policy that keeps deletion available to payment-locked accounts.

The browser E2E starts the production browser composition with test-only HTTP
responses, uses existing and newly opened tabs, gives two Vaults the same
CardId, and verifies that a revocation `retry-wait` immediately quiesces the
existing peer and blocks the new runtime while local database/cache/worker data
is still retained. Only recovery beyond revocation runs purge. Reload,
back/forward navigation, and continuation completion cannot resurrect the
deleted Vault or affect the other Vault.

## Security and rollback

The continuation capability must survive session revocation, so its browser
storage treats it as a high-entropy, owner-bound, sequence-rotated capability,
omits it from URLs and logs, and removes it only with the terminal marker's
conditional clear. The server initially bounds it to seven days, then promotes
only the already-authorized saga when the revoke claim commits so it can
recover after the live session is gone. Same-origin script can read IndexedDB;
preventing script injection remains a required application security control.

If the seven-day token expires before the revocation claim, the runner renews
only after Resume returns the exact decoded `continuation-required` denial. It
uses the durable marker's same idempotency key for authenticated Start replay,
then compare-and-swap persists the returned capability before retrying Resume.
An arbitrary 401 never takes this path. Renewal requires a live authenticated
session in the same Account/Vault owner scope and the server operation to
remain initial with zero receipts;
ordinary unexpired replay and lost renewal responses are idempotent without a
sliding expiry. Once a claim exists, Start cannot renew: the claim transaction
has instead promoted the already-authorized operation's continuation for
long-lived recovery.

Rolling back the visible composition is safe only if the durable adapter and
runner remain able to detect and finish existing markers. A deployed rollback
must not ignore or delete either account-deletion or logout markers. This
change performs no production migration, deletion, email, payment, deployment,
or `main` update.
