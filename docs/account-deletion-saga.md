# Account deletion saga foundation

## Go migration status (T12b)

Issue #458 ports the provider-neutral saga to
`backend/internal/accountdeletion` and PostgreSQL migration
`00014_account_deletion_saga.sql`. The fixed step order, typed states, bounded
leases and retries, prefix receipts, and compare-and-swap transitions are now
covered by Go unit and PostgreSQL integration tests. The shared account
lifecycle fixture is decoded by the retained TypeScript browser status test and
the Go codec so the public wire states cannot drift; the TypeScript saga server
and its tests were removed by T17.

`account_deletion_operations` intentionally has no live Account/Vault foreign
key; a continuation and minimal journal must survive finalization long enough
to report the terminal result. An insert trigger nevertheless requires the
exact current Personal Vault owner for every new operation. Receipts and
continuations remain operation-owned and cascade only with that journal.
PostgreSQL tests cover owner rejection, cross-owner operation-ID collision,
sequence and revision races, exact replay, atomic success receipts, malformed
stored rows, and journal access after live Account/Vault removal.

The Go application exposes one explicit port for each effect: session
revocation, immediate subscription cancellation, Vault live-data purge,
private-object purge, and account finalization. A continuation sequence is
consumed before a step is claimed; only a newly applied claim can dispatch an
effect. Provider errors become the non-sensitive `effect-unavailable` code.
Operation ID plus step is the stable effect identity; adapters must make that
identity idempotent across timeout and lease recovery.

Private-object deletion is the only step allowed to report durable productive
progress without a receipt. Confirmed outbox shrink resets the retry budget and
returns the same step ready for another bounded batch; zero progress consumes
the ordinary finite retry policy. Concurrently drained rows count as replayed
progress, while changed rows remain conflicts. The other four steps may only
succeed, retry/fail, or commit their next receipt.

Initial continuations expire after seven days. The transaction that claims the
first `revoke-sessions` step promotes that exact operation's already-authorized
continuation to the maximum safe timestamp before invoking the effect. This
phase-bound recovery credential closes the claim/effect and effect/receipt
crash windows after sessions are gone; it cannot authorize a new operation or
read owner data, and sequence replay stays limited to current/immediately prior.

The pre-claim expiry window has a narrower recovery path: an authenticated
same-idempotency Start replay may atomically extend expiry only for the exact
initial `Ready(revoke-sessions, attempt=0)` operation with no receipt or effect.
It preserves the stored secret and sequence, is idempotent across a lost
renewal response, and leaves ordinary unexpired Start replay read-only rather
than sliding expiry. It rejects another owner/key, an expired session, or any
claimed/receipted state without mutation. The browser enters this path only for
the exact decoded `continuation-required` Resume denial and durably records the
renewal before retrying Resume.

Issue #460 implements the PostgreSQL session-revocation adapter and the Go
Billing immediate-cancellation service. Issue #462 implements the PostgreSQL
Vault live-data purge and the database write gate that prevents post-start
Vault data recreation. Issue #464 implements the bounded PostgreSQL-outbox and
private-object purge. Issue #466 implements account finalization with an
explicit fail-closed legal-evidence policy and a PostgreSQL gate that prevents
new evidence after deletion starts. Issue #512 connects those effects only in
the exact disposable local fixture, using the no-network commerce provider,
anchored real filesystem directories, and explicit
`delete-live-evidence`. `undecided`, default, and production-shaped profiles
remain unmounted. Issue #468 connects a verified privacy deletion request only to
the durable saga start. Issue #513 composes that handoff only inside the explicit
disposable `delete-live-evidence` graph; normal privacy HTTP exposes Submit and
Status but no Verify or Process endpoint. Its scoped deterministic identity makes a lost response
replay one operation without executing any step, and `account-deletion-started`
does not mean deletion completed. Issue #474 adds an exact-owner read-only
`notesctl account-deletion inspect` command. It reports durable state and timing
without consuming the continuation, claiming a step, or invoking an effect;
the exact fixture's mutating runner remains the reviewed browser/HTTP path, not
an operator command. No provider, production migration, production deletion,
deployment, or public route is enabled by this local connection.
The sections below describe the pre-existing TypeScript/D1 implementation that
the Go port preserves as its compatibility oracle.

Issue #168 introduces only the durable, provider-neutral foundation for account
deletion. It does not expose an HTTP endpoint, revoke a session, cancel a real
subscription, delete content, contact R2 or KMS, or change browser storage.

## Ordered steps

Every operation starts at `revoke-sessions`; callers cannot select or skip a
step.

1. `revoke-sessions`
2. `cancel-subscription`
3. `delete-vault-data`
4. `delete-private-objects`
5. `finalize-account`

The later implementation Issues #169–#175 own those effects. They receive the
stored Account/Vault scope rather than accepting ownership identifiers from an
untrusted request body.

## State and retry contract

The pure core moves an operation through `ready`, `running`, `retry-wait`,
`terminal-failure`, and `completed`. Clock reads, UUID generation, retry delays,
and lease durations are supplied by outer adapters. No default delay or lease
is silently chosen by the core.

A worker claims a `ready` step with a bounded lease. If the process crashes,
another worker can recover the expired lease through the same configured retry
policy. A retryable failure becomes terminal when the injected delay list is
exhausted. Terminal provider failures are never retried automatically.

Successful step transitions and their minimal receipt are committed in one D1
batch. The receipt contains only operation ID, step, and completion time. It
does not contain content, identity claims, session tokens, payment data,
ciphertext, or key material. Replaying an already persisted transition returns
the stored snapshot; a stale revision returns a CAS conflict.

## Persistence and deletion ordering

`account_deletion_operations` allows one durable operation per Account and is
queried with both AccountId and VaultId. Receipts must form an exact prefix of
the fixed step list. Rows are decoded from `unknown`, and an impossible
operation/receipt combination fails closed.

The operation deliberately has no foreign key to the live Account/Vault rows.
That lets the final step remove live control-plane state while retaining a
minimal progress record for retry and the separately governed retention
window. Its receipts do have an internal foreign key to the operation.

The legacy migration `0009_account_deletion_saga` is additive and part of the explicit
production manifest. This change does not apply it to production. Rolling code
back stops new operations but must preserve operation and receipt rows so an
in-progress deletion can be resumed by the later implementation or runbook.

## Exact local development connection

The exact fixture runs this saga against the real disposable PostgreSQL graph
and real private fixture files. Startup proves the complete database and
filesystem inventory before mounting anything. One lifetime Vault activity
fence covers all Sync v2 calls and deletion Start; Start seals admission before
waiting for active sync and never reopens after an accepted or potentially
committed operation. The local host lock and PostgreSQL advisory lock exclude
cooperating runtime and `notesctl prepare-e2e` processes. Keeper loss makes
readiness and mutation wrappers fail closed.

Every receipt boundary and effect-before-receipt crash window is exercised by
close-and-recompose tests. Object deletion uses anchored directory handles and
quarantine so a response-loss replay confirms only the exact outbox object.
Finalization correlates the database wrapped-key metadata with the exact key
file, removes database metadata before key/nonce files, fsyncs, and requires the
completed object/key/nonce directories to be empty. These are disposable local
effects only: no network, Stripe, Cloudflare, provider KMS, production database,
deployment, or `main` operation is performed.
