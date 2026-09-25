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

## Not implemented by this command

- checking application/provider evidence for a reservation;
- deriving release evidence or automatically releasing a reservation;
- pagination beyond the explicit bounded first page;
- recurring scheduling or cron registration;
- billing reconciliation, DEK rotation, re-encryption, orphan scan, delete
  outbox, account-deletion advancement, or recovery drill runners.

Those effects require separate typed commands, tests, and review. Age alone is
never evidence that a quota reservation is safe to release.

## Rollback

Stop invoking the commands and roll back the application artifact to the prior
integration commit. T13a and T13b add no schema. T13a writes no data. A T13b
commit is an intentional quota-ledger transition backed by an existing Sync
receipt and must not be reversed by deleting rows or synthesizing a release.
Preserve emitted audit evidence and reconcile any in-flight invocation before
application rollback.
