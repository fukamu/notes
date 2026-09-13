# Logout runtime fence and multi-tab coordination

Issue #147 connects the crash-resumable logout decisions from #144 to a
provider-neutral runtime fence and a browser BroadcastChannel/Web Locks
adapter. It still performs no IndexedDB, CacheStorage, Service Worker, graph
worker, or navigation deletion; those effects and the logout E2E belong to
#148.

## Race-free runtime entry

An authenticated Vault runtime must receive an injected
`LogoutRuntimeFencePort`; there is no allow-all default. Entry performs these
steps before constructing `NotesRuntimePorts`:

1. read and decode the global non-content purge marker;
2. open the Vault-scoped coordination channel and subscribe;
3. acquire a shared Vault runtime Web Lock;
4. read and decode the marker again.

Missing progress permits the next step. Pending, corrupt, unsupported-version,
or unavailable progress fails closed. The second read closes the race where a
purge starts between the first read and lock acquisition. Subscribing before
the lock request also prevents a purge request from being lost while a runtime
is waiting for its shared lock.

When a valid request arrives, `SessionNotesApp` changes the mounted Provider to
its fenced state. `NotesProvider` stops its operation lifecycle and scheduled
sync in a layout effect and removes presentation children. Only the following
passive effect releases the shared lock. In-flight load/save/sync completions
therefore fail #143's epoch/lifecycle checks before the purge owner can prove
runtime quiescence.

The current `LegacyNotesApp` does not use this authenticated composition and
remains the explicit auth- and billing-free local development harness.

## Protocol and ownership

The strict `logout-coordination/v1` protocol contains only AccountId, VaultId,
SessionId, SessionEpoch, a positive purge target attempt, and UUID tab IDs. It
has `purge-request`, `peer-quiesced`, and `purge-completed` variants. Every
incoming `MessageEvent.data` is treated as `unknown` and decoded once. Content,
conflicts, session tokens, OTPs, and key material are absent.

Peer state is a discriminated union: active, quiescing, quiesced, or completed.
Duplicate, stale, foreign-generation, wrong-owner, and out-of-order messages
cannot move the state. A new owner must use a higher #144 target attempt after
crash recovery. A quiesced peer can safely re-ack that retry without restarting
its runtime.

An exclusive Vault owner Web Lock permits one purge coordinator. A second owner
gets an explicit contended failure. After broadcasting the request, the owner
acquires an exclusive runtime lock and retains that lease for the later purge
effects. Acquiring it proves that all participating shared runtime locks,
including the owner tab's runtime, were released. Peer acknowledgements are
generation/attempt/owner-bound diagnostics; they are not substituted for the
exclusive-lock proof and self-acknowledgements are not counted as peers.

Browser absence, timeout, contention, channel/lock failure, and malformed
messages remain typed failures. Unsupported capability never becomes success.
Closing or crashing a browser owner releases Web Locks; #144 then recovers its
persisted running target as interrupted and a new owner can retry with the next
attempt.

## Rollback and remaining work

The provider-neutral composition accepts an injected progress port; the
browser adapter supplies only channel, lock, timeout, and tab-ID effects. It is
not wired to a production route or fake fallback. Rollback removes the
protocol, coordination
ports/adapter, and authenticated fence while preserving #109, #113, #143, and
#144. It changes no server schema or data.

#148 supplies durable browser progress storage, retains the exclusive runtime
lease across actual cache/worker/database deletion, verifies deletion, and
clears the marker. Its browser E2E proves that back/forward, another tab,
workers, and a later Vault login cannot resurrect the deleted content. See
[Browser logout purge](browser-logout-purge.md).
