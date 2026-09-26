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

## Vault DEK rotation

The T13e command starts or resumes one exact Account/Vault-scoped durable DEK
rotation. The operation ID and all three monotonic timestamps are stable
operator inputs and must be preserved for every retry:

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
NOTES_GCP_KMS_CRYPTO_KEY_VERSION='projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION' \
NOTES_GCP_KMS_ACCESS_TOKEN='<separately-approved-short-lived-token>' \
go -C backend run ./cmd/notesctl dek rotate \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --operation-id=01991f20-61d2-7000-8000-000000000401 \
  --requested-at-millis=1725000000000 \
  --generated-at-millis=1725000000100 \
  --completed-at-millis=1725000000200 \
  --confirm-kms-key-generation
```

The runner durably records `generating` before `KeyManagementPort` is called,
records only wrapped metadata before promotion, and changes the logical write
version only in the final PostgreSQL transaction. A provider failure therefore
leaves the operation resumable. Retrying the exact command while `promoting`
skips key generation; retrying after completion returns `replayed` without a
KMS request. A different operation cannot replace unfinished work. Unknown and
cross-owner scopes share the same refusal and cause no provider request.

`generated-at-millis` is also the durable creation timestamp supplied to the
provider-neutral key adapter, so it must be no earlier than the request time;
the completion time must be no earlier than generation. Keeping these values
stable makes retries reproducible rather than substituting a later process
clock. Successful output contains only command kind, `completed` or `replayed`,
operation ID, and those timestamps. It omits Account/Vault IDs, database URL,
access token, KMS resource, wrapped/raw key material, and dependency errors.

Local/test database access remains restricted to the disposable loopback
database. The provider resource and access token are accepted only through the
environment and are never printed. `--confirm-kms-key-generation` and the
additional production-form `--confirm-production-kms-mutation` are accidental-
run guards, not authorization. This delivery used injected fakes and the
disposable PostgreSQL database only; it made no real KMS request.

Production use remains unapproved. Before any invocation, separately review
the runtime identity/token source, exact CryptoKeyVersion, region and protection
level, IAM, network path, availability/quota monitoring, audit retention,
per-operation KMS cost, and shared-service impact. Alternatives remain a
dedicated project/key, a different provider behind `KeyManagementPort`, or
keeping rotation stopped while all existing wrapped versions remain readable.
No option permits key disablement or destruction; that remains behind the
recovery and retirement approval gate.

## Vault ciphertext re-encryption

The T13f command advances one bounded batch for one exact Account/Vault and
the already-promoted target DEK version. It is intentionally available only in
`local` or `test`; there is no production-form syntax.

Before a local drill, create two distinct, existing directories with mode
`0700`. The object directory must contain the immutable ciphertext files named
by their exact `obj_v1_...` keys. The nonce directory is an append-only local
reservation ledger. Neither directory is a production object-storage or nonce
store recommendation.

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
NOTES_GCP_KMS_CRYPTO_KEY_VERSION='projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION' \
NOTES_GCP_KMS_ACCESS_TOKEN='<separately-approved-short-lived-token>' \
go -C backend run ./cmd/notesctl dek reencrypt \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --target-version=2 \
  --limit=100 \
  --performed-at-millis=1725000000000 \
  --object-root=/absolute/private/object-directory \
  --nonce-root=/absolute/private/nonce-directory \
  --confirm-local-object-writes \
  --confirm-kms-unwrapping
```

The command verifies exact Account/Vault ownership and loads a valid keyring
whose write version equals `target-version` before object storage or KMS can be
reached. It then calls the existing durable re-encryption service exactly once
with a limit from 1 through 100. Each candidate is authenticated with its
stored Vault/object/revision AAD, written under a fresh immutable object key,
and committed by metadata CAS together with the old-key delete-outbox entry and
job checkpoint. It never deletes the old object or retires a key.

`pending` is a successful bounded invocation that must be repeated. The reason
distinguishes page limit, scan restart, CAS conflict, or an older pending write.
Keep the same `performed-at-millis` when retrying an uncertain invocation; a
later intentional batch may use a later, never earlier timestamp. A completed
job returns with zero processed objects and performs no storage, encryption,
object-key generation, or KMS work.

The local object adapter uses create-if-absent immutable files and persists
replacement bytes before the PostgreSQL CAS. The local nonce adapter uses
exclusive append-only marker creation and stores only a SHA-256-derived marker
name. Both reject relative paths, symlink roots, non-directory roots, and roots
accessible by group or other users. Output contains only command kind,
`completed` or `pending`, processed count, target version, and pending reason;
it omits scope IDs, paths, database/KMS configuration, object keys, ciphertext,
wrapped/raw keys, nonces, and dependency errors.

The confirmation flags are accidental-run guards, not authorization. This
delivery uses injected fakes, temporary directories, and the loopback
disposable database only. It makes no real KMS call. Any invocation that would
use a real token/provider requires separate approval even in a local/test-form
command. A real object provider, persistent production nonce store, runtime
identity, exact KMS resource, IAM/network, region/retention, monitoring, cost,
and shared-service impact remain unapproved.

## Orphan-object scan

The T13g command identifies old immutable files that have no committed
metadata, active write intent, or existing delete-outbox row in any Vault, then
enqueues only a bounded batch for one exact Account/Vault. It is available only
for `local` and `test`; there is no production-form syntax and it does not
delete object bytes.

Create or select the exact existing private directory used by the disposable
drill. It must be absolute, resolve without symlinks, and be inaccessible to
group and other users (normally mode `0700`).

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl objects orphan-scan \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --scan-started-at-millis=1725000000000 \
  --grace-period-millis=86400000 \
  --limit=100 \
  --object-root=/absolute/private/object-directory \
  --confirm-local-object-scan \
  --confirm-delete-enqueue
```

The exact owner check completes before the directory inventory or any enqueue.
The cutoff is inclusive: only objects created at or before
`scan-started-at-millis - grace-period-millis` are eligible. A batch enqueues
at most `limit` rows. `pending` means another pass may remain; repeat with the
same scan start, grace, limit, scope, and directory. Existing outbox rows are
globally protected, so an uncertain retry cannot duplicate them and resumes in
stable object-key order. A concurrent commit or intent wins because each
enqueue rechecks both tables in PostgreSQL.

Successful output contains only command kind, `completed` or `pending`, the
enqueued count, and the declared limit. Account/Vault IDs, directory path,
object keys, database configuration, file contents, and dependency errors are
not printed. The two confirmation flags are accidental-run guards, not
authorization for a shared directory or database. Tests use temporary files,
an in-memory adapter, and the disposable loopback database only. A real object
provider, production inventory or enqueue, provider credentials, region,
retention, monitoring, cost, and scheduler remain unapproved.

## Encrypted-object delete outbox

The T13h command drains one bounded due batch for an exact Account/Vault. It is
available only for `local` and `test`; it has no production-form syntax. Use it
only with the disposable database and directory created for the drill. The
directory must be absolute, resolve without symlinks, and deny group/other
access (normally mode `0700`).

```bash
NOTES_ENVIRONMENT=test \
NOTES_DATABASE_URL='postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable' \
go -C backend run ./cmd/notesctl objects delete-outbox \
  --environment=test \
  --account-id=01991f20-61d2-7000-8000-000000000101 \
  --vault-id=01991f20-61d2-7000-8000-000000000201 \
  --attempted-at-millis=1725000000000 \
  --retry-delay-millis=60000 \
  --limit=100 \
  --object-root=/absolute/private/object-directory \
  --confirm-local-object-deletes \
  --confirm-delete-outbox-mutation
```

The exact owner check precedes selection and object deletion. Selection is
stable by `next_attempt_at` then opaque object key and excludes any key that is
currently committed or held by an active write intent. Such a protected row is
not discarded; the outcome remains `pending` so the inconsistency can be
investigated.

For each selected row, storage `deleted` and `not-found` both advance the
outbox. This makes an uncertain response resumable: if bytes were removed but
PostgreSQL confirmation was lost, the repeat sees `not-found` and confirms the
same row. Other storage failures reschedule the row at
`attempted-at-millis + retry-delay-millis` with its attempt incremented once.
Applied, already-replayed, and losing-CAS mutations are reported separately;
a competing row is never overwritten.

`completed` means the scoped outbox count was zero after this pass. `pending`
includes additional due rows, future retries, protected rows, and a competing
mutation. Repeat with a new explicit attempted time appropriate for the retry
policy; do not edit attempts or delete rows/files manually. Successful output
contains only command/outcome, completed/retried/replayed/contended counts, and
the declared limit. It never includes Account/Vault IDs, object keys, paths,
database configuration, file contents, or dependency errors.

The two confirmations guard accidental local invocation only. They do not
authorize a shared database/directory, production provider, credential,
scheduler, deployment, cost, or external request. The account-deletion purge is
a different operation and continues to require its running saga state and
prior receipt.

## Remaining operations boundaries

- checking application/provider evidence for a reservation;
- deriving release evidence or automatically releasing a reservation;
- pagination beyond the explicit bounded first page;
- recurring scheduling or cron registration;
- account-deletion advancement or recovery drill runners;
- production KMS identity/resource composition and recurring scheduling.

Those effects require separate typed commands, tests, and review. Age alone is
never evidence that a quota reservation is safe to release.

## Rollback

Stop invoking the commands and roll back the application artifact to the prior
integration commit. T13a through T13h add no schema. T13a and T13c write no
data. A T13b commit is an intentional quota-ledger transition backed by an
existing Sync receipt and must not be reversed by deleting rows or
synthesizing a release. A T13d applied/ignored provider snapshot and its
checkpoint are authoritative Billing evidence and must likewise be preserved,
not deleted or rewritten. Preserve emitted audit evidence and reconcile any
in-flight invocation before application rollback. T13a/T13c can simply be
stopped and repeated; T13d can be retried with the exact same snapshot inputs.
A T13e rollback stops new rotation commands but preserves the operation row,
every old/new wrapped key version, and the current logical write pointer. An
interrupted operation resumes with the exact operation ID and timestamps;
never delete a pending row, disable a referenced provider key, or restore the
old write pointer by hand. A T13f rollback stops new batches and preserves the
durable job/checkpoint, current metadata, every source and replacement object,
nonce reservations, and delete-outbox rows. Resume from the stored checkpoint;
do not reset it, delete a newly written orphan by hand, remove an old object,
or retire either DEK version to reverse application code. A T13g rollback
stops new scans but preserves every enqueued outbox row and object. Resume or
drain those rows only through reviewed operations; never remove rows or object
files by hand to reverse the application artifact. A T13h rollback stops new
drains but cannot restore bytes already deleted from disposable storage. Keep
every remaining outbox row and its retry metadata, reconcile any uncertain
invocation by replaying the same scoped operation, and never recreate an
immutable key or delete a row by hand. Production recovery and backup restore
remain unapproved and were not exercised by this command.
