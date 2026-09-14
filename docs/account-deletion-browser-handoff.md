# Account deletion browser handoff core

Issue #175 defines the pure browser handoff state machine and runner between the
server boundary from #174 and the existing crash-resumable logout purge from
#148. Browser persistence, HTTP adapters, authenticated UI, and end-to-end
composition are separate dependent Issues #183 and #184. This Issue does not
deploy a route or perform a production deletion.

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

## Security and rollback

The continuation capability must survive session revocation. Its browser
storage implementation in #183 must therefore treat it as a high-entropy,
owner-bound, sequence-rotated, expiry-bound capability, omit it from URLs and
logs, and remove it only with the terminal marker's conditional clear.

Rolling back #175 removes only the unused core and runner before #183/#184 are
integrated. Once a browser marker can be created, a deployed rollback must keep
the durable boundary able to detect and finish it. This change performs no
production migration, deletion, email, payment, deployment, or `main` update.
