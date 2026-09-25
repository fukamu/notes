# Go operations runner

`notesctl` is the explicit, non-HTTP operations entry point for the Go backend.
This document records implemented commands and safety boundaries. It is not
permission to connect to production or shared resources, deploy, register a
scheduler, mutate production data, or incur cost.

## Quota reconciliation audit

The first T13 command lists a bounded set of overdue quota reservations for
manual evidence review. It is read-only and cannot finalize a reservation.

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl quota reconcile-list \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --as-of-millis=1725000000000 \
  --limit=100
```

All five scoped values are required. Flags may be reordered but may not be
duplicated. `--limit` is between 1 and 100. The as-of value is a non-negative
JavaScript-safe integer expressed in Unix milliseconds. Local and test runs
are restricted to loopback and the exact disposable
`fukamu_notes_go_test` database.

A production-form command also requires
`--confirm-production-read-only`. This is only a fail-closed CLI guard. Do not
run it against a production or shared database without separate explicit user
approval for that exact target and operation.

Successful output is one JSON object. Candidate entries contain only
`reservationId` and `reconcileAfter`; the scoped Account/Vault IDs and database
configuration are not echoed. Unknown ownership, malformed arguments,
environment mismatch, cancellation, storage errors, and malformed stored data
fail without a candidate document or dependency error details.

## Replay and resume

The command is a deterministic ordered read for the supplied scope, as-of
timestamp, and maximum count. Preserve those inputs with the output when an
audit must be reproduced. Re-run the same command after interruption. A later
run may legitimately differ if another operation finalized or added a
reservation; this command itself performs no write.

## Evidence-confirmed quota commit

The T13b command finalizes one due reservation only when the same scoped
PostgreSQL database contains an immutable Sync v2 commit receipt that exactly
matches the reservation's mutation/reservation ID, fingerprint, card ID, and
original request timestamp.

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl quota reconcile-commit \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --reservation-id=01991f20-61d2-7000-8000-000000000401 \
  --finalized-at-millis=1725000000000 \
  --confirm-durable-sync-receipt
```

The command refuses a missing or mismatched receipt, unknown or cross-owner
scope, unknown reservation, a reservation that is not yet due, and a
reservation already released. It never uses age as evidence and has no release
mode. A successful retry is reported as `replayed`; the quota usage revision is
not advanced again. Concurrent attempts serialize through the quota ledger so
exactly one attempt commits the reservation and the other observes replay.
The adapter locks and rechecks the receipt inside the same serializable
transaction that updates quota. Evidence removed or changed after the initial
inspection becomes a refusal rather than a stale-evidence commit.

The command uses the currently implemented paid Personal Vault limits. A
future product with per-owner limit versions must add durable limit evidence
before this runner can support it; the operator cannot supply limits as flags.
Output contains only the command kind, outcome, reservation ID, and finalization
timestamp. Database configuration, Account/Vault scope, receipt fingerprint,
card ID, quota values, and dependency errors are not printed.

A production-form command additionally requires
`--confirm-production-mutation`. Both confirmation flags are fail-closed CLI
guards, not authorization. Do not connect to or mutate a production/shared
database without separate explicit approval for the exact target, reservation,
and operation.

## Account-deletion audit

The T13c command inspects one exact durable account-deletion operation without
consuming its continuation, claiming a step, or calling any effect:

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl account-deletion inspect \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --observed-at-millis=1725000000000
```

The result distinguishes a due or waiting step, an active or expired lease, a
retry wait or due retry, terminal failure, and completion. `readyToAdvance`
means that the persisted timing permits the later reviewed runner to advance
the state; it does not authorize or perform that advancement. `relevantAt` is
the stored not-before, lease-expiry, retry, terminal-update, or completion
timestamp for the reported state.

Output includes only the command kind, operation ID, state, current step when
one exists, readiness, relevant timestamp, and supplied observation timestamp.
It omits Account/Vault IDs, continuation secret or digest, receipt contents,
failure code, billing references, database configuration, and dependency error
text. Unknown and cross-owner scopes use the same refusal. Repeating the same
read against unchanged state returns the same result and does not change the
operation revision, receipts, or continuation sequence.

Local and test execution uses the same loopback disposable-database guard as
the quota commands. Production-form syntax requires
`--confirm-production-read-only`; the flag is not authorization to access a
production or shared database. No production audit was run by this delivery.

## Billing provider reconciliation

The T13d command retrieves and commits one provider snapshot for an exact
Account/Vault-owned Billing subscription:

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
NOTES_STRIPE_API_KEY='<separately-approved-test-key>' \
go -C backend run ./cmd/notesctl billing reconcile \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --snapshot-id=manual-2026-09-26T00:00:00Z \
  --observed-at-millis=1725000000000 \
  --recorded-at-millis=1725000000100
```

The stable snapshot ID and both timestamps are operator inputs. The command
derives the internal subscription ID and Stripe customer/subscription
references from the exact owner-scoped PostgreSQL record; none is accepted as
a flag. The returned subscription must match both stored Stripe references. A
missing/cross-owner subscription, non-Stripe or malformed provider mapping,
or conflicting use of an existing snapshot ID is refused before any Stripe
request. An exact durable checkpoint returns `replayed` without contacting the
provider. Concurrent identical attempts rely on Billing's atomic checkpoint
and projection CAS, so only one applies and the other becomes a replay.

Successful output contains only command kind, `applied`, `ignored`, or
`replayed`, the snapshot ID, and the supplied timestamps. It never prints the
API key, database URL, owner scope, provider customer/subscription references,
invoice/payment details, or dependency errors. Provider outages and malformed
snapshots return a generic failure and grant no entitlement.

Local/test execution remains restricted to the loopback disposable database
and selects Stripe test mode. Production-form syntax additionally requires
`--confirm-production-provider-read` and selects live mode. That flag is only
an accidental-run guard: it does not authorize access to a production/shared
database, use of a Stripe credential, a live provider read, deployment, or
cost. This delivery's tests inject fakes or local HTTP stubs; no real Stripe
request was made.

## Remaining operations boundaries

- checking application/provider evidence for a reservation;
- deriving release evidence or automatically releasing a reservation;
- pagination beyond the explicit bounded first page;
- recurring scheduling or cron registration;
- DEK rotation, re-encryption, orphan scan, delete outbox,
  account-deletion advancement, or recovery drill runners.

Those effects require separate typed commands, tests, and review. Age alone is
never evidence that a quota reservation is safe to release.

## Rollback

Stop invoking the commands and roll back the application artifact to the prior
integration commit. T13a through T13d add no schema. T13a and T13c write no
data. A T13b commit is an intentional quota-ledger transition backed by an
existing Sync receipt and must not be reversed by deleting rows or
synthesizing a release. A T13d applied/ignored provider snapshot and its
checkpoint are authoritative Billing evidence and must likewise be preserved,
not deleted or rewritten. Preserve emitted audit evidence and reconcile any
in-flight invocation before application rollback. T13a/T13c can simply be
stopped and repeated; T13d can be retried with the exact same snapshot inputs.
