# Production operations launch, restore, canary, and rollback runbook

Issue #218 defines provider-neutral decisions and evidence for future operations.
Issue #502 ports that frozen decision policy to the import-free Go core in
`backend/internal/operations/launch_policy.go`. It contains no provider command,
credential, endpoint, tenant identifier, production executor, clock read, or
environment read. A passing gate is evidence of readiness, never authority to
perform an external operation. Production deployment, restore, data mutation,
webhook or alert registration, data deletion, and key destruction each retain
their separate explicit-approval requirement.

## Environment boundaries

| Environment | Intended use                             | Allowed by this work                            | Prohibited by this work                                                    |
| ----------- | ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| local       | developer machine                        | fixture-only drill and fake adapters            | remote provider calls, real credentials, production data                   |
| test        | CI and deterministic test process        | fixture-only drill and fake/emulator adapters   | production endpoint, paid verification, real email or billing              |
| staging     | isolated non-production validation       | gated restore drill, canary, rollback rehearsal | production mutation, key destruction, copying plaintext production content |
| production  | paid public service after later approval | evidence evaluation only                        | execution without a separately identified explicit approval                |

Go `operations.PlanEnvironmentAction` is the authoritative matrix. A restore
drill must target isolated staging, never production.

Data deletion and key destruction are outside this launch workflow in every
environment. Provider webhook and alert configuration also remain outside it
until a provider, account, retention policy, and destination have been approved.
Unknown environment or action values produce a blocked plan rather than an
executable default.

Operational evidence contains fixed states and counts only. Do not place card
content, plaintext, ciphertext bodies, raw keys, OTPs, tokens, cookies, payment
details, raw AccountId/VaultId/CardId, credentials, or provider command output in
the evidence artifact. Store the separate audit-system references needed to
identify target, requester, reviewer, backup, and change record in that approved
system, not in telemetry labels or this repository.

## Launch-gate evidence

An eventual adapter must strictly decode external evidence before constructing
Go `operations.LaunchGateEvidence`, then pass that typed value to
`operations.EvaluateLaunchGate`. The pure core independently rejects an unknown
enum, unsupported schema version, malformed rollback-window state, or timestamp
outside the non-negative JavaScript-safe integer range. T17 removed the frozen
TypeScript decoder; its immutable revision remains historical comparison
evidence only.

The gate requires a confirmed target, the environment-appropriate change
approval, an open rollback window, ready telemetry, and resolved operational
decisions. Production additionally requires two-person review. A migration
requires verified backup evidence; destructive migration is blocked by this
workflow.

A complete staging result is `ready`. A complete production result is still
`explicit-production-operation-approval-required`; no code path turns that result
into a deploy, restore, rollback, or provider API call. Missing evidence produces
ordered blocker reasons suitable for a change record, without secrets or tenant
identifiers.

## Restore drill

Run only against an isolated staging target with fake or approved staging
adapters. The source inventory and restore destination must never be a live
production target under this procedure.

1. **Inventory** — freeze the drill manifest; enumerate PostgreSQL metadata,
   private object-storage
   object metadata, wrapped DEK versions, session revocation state, billing
   projection, migration version, capture time, and delete-after time. Reject an
   incomplete inventory and any backup retention window over 30 days.
2. **Isolated restore** — create or select a disposable, access-restricted staging
   target. Restore metadata and immutable ciphertext first, then wrapped-key
   metadata. Keep outbound email, Stripe mutation, and production sync disabled.
3. **Integrity, crypto, and tenant verification** — authenticate a minimum
   synthetic fixture with exact Vault/object/revision AAD; verify partition and
   Vault scope, tombstones, cursor/page boundaries, session revocation, billing
   lock, migration version, and that cross-tenant reads fail. KMS failure remains
   fail closed and plaintext fallback is forbidden.
4. **Evidence** — record only fixed result codes, schema/key versions, counts,
   timestamps, and approved audit references. A partial restore, authentication
   failure, missing object, stale billing projection, or unresolved tenant check
   is a failed drill and cannot satisfy the gate.
5. **Cleanup** — revoke drill sessions, remove the isolated fixture through the
   approved non-production cleanup procedure, verify no external delivery was
   enabled, and retain only redacted evidence for the approved duration. A blocked
   cleanup is an incident, not success.

The drill validates a point-in-time staging fixture. It does not prove provider
snapshot consistency, production IAM, quota, latency, or an achievable RTO/RPO.

## Canary gates

### Entry

- Confirm the exact environment, immutable change reference, target, and
  backward-compatible migration state.
- Confirm two-person review for production, verified backup when schema/data is
  touched, an open rollback window, and resolved provider/runbook decisions.
- Confirm the telemetry vocabulary from Issue #217 can observe service failure,
  integrity failure, billing lock, and billing-provider failure without content
  or tenant identifiers.
- Keep destructive migration, provider registration, data deletion, and key
  destruction out of the canary.

### Observe

Compare canary and baseline for auth denials, Sync V2 success/no-change/failure,
billing locks, PostgreSQL/object-storage/KMS dependency failure, cursor/receipt
replay, and cross-tenant denial. Use approved staging-derived thresholds only.
No-change sync must not call object storage or KMS. Record whether each signal
is healthy, failed, or unavailable; an unavailable required signal blocks
promotion.

### Promote

Promotion requires an observed—not merely started—canary, every entry condition,
healthy required signals, and an open rollback window. For production, the pure
gate still returns an explicit-approval requirement. Promotion must stop if any
required alert threshold, provider owner, or escalation destination remains a
Decision Required.

### Abort

Stop promotion on integrity or tenant-isolation failure, unknown migration state,
KMS fail-open behavior, loss of billing lock enforcement, malformed sync data
loss, unavailable required telemetry, or a closed rollback window. Preserve
evidence and choose code rollback or data recovery using the decision tree; do not
delete data or keys as an abort shortcut.

The decision to stop promotion does not require healthy telemetry, a new backup,
or resolved provider decisions: those failures are reasons to abort. Removing a
production canary or performing a rollback remains an external operation requiring
the separately identified approval.

## Rollback decision tree

1. If the change is code-only and the prior code understands the current schema
   and ciphertext versions, stop promotion and prepare a code rollback within the
   confirmed window.
2. If a backward-compatible migration ran, keep the migrated schema/data and roll
   code back only when the prior version is explicitly compatible. Do not reverse
   live writes by assumption.
3. If data integrity is uncertain, stop writes for the affected provider-neutral
   scope, preserve all versions and evidence, and escalate to the data-recovery
   path. Restore only after an isolated restore has verified the exact backup.
4. If key versions changed, preserve old and new wrapped keys and mixed-version
   ciphertext. Code rollback must not retire or destroy a key. Follow the separate
   rotation recovery and retirement gate.
5. Account deletion, session revocation, paid entitlement lock, and confirmed
   tombstones are monotonic security state. Rollback must not resurrect deleted
   live data, revoked sessions, destroyed keys, or unpaid online access.

Code rollback and data recovery are distinct operations. Neither is authorized by
this document, a CI result, a merge, or a passing launch gate.

## Failure and escalation matrix

| Failure                                                 | Immediate operator action                                                            | Preserve / verify                                                                        | Escalation                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| PostgreSQL unavailable, conflict, or migration mismatch | stop promote; retry only idempotent reads/commands per policy                        | metadata revision, migration version, receipts; never run ad-hoc DDL                     | service operations and data owner      |
| object storage unavailable, missing, or size mismatch   | stop affected write/restore and keep metadata pending                                | immutable object key/version and delete outbox state; no plaintext fallback              | service operations and storage owner   |
| KMS unavailable or authentication failure               | fail closed; stop decrypt/encrypt/promotion                                          | wrapped-key and crypto versions, integrity result; never log key material                | security operations and KMS owner      |
| Stripe webhook/API unavailable or out of order          | keep/reconcile durable event state; preserve online lock on failure/action-required  | event dedupe/reconcile status and invoice state; redirect/card update is not entitlement | billing operations and billing owner   |
| auth Google/OTP/session anomaly                         | stop affected authentication path; rotate/revoke only through approved state machine | bounded failure category, epoch/revocation result; never log OTP/token/cookie            | security operations and identity owner |
| Sync V2 malformed page, cursor, CAS, or receipt failure | do not advance cursor/ack; preserve local mutation for retry                         | page boundary, high-watermark category, replay/conflict result; no content               | service operations and sync owner      |

An incident lead records target and audit references outside telemetry, assigns a
service/security/billing owner, and records the handoff. If the correct response
would deploy, mutate production data, restore production, register a production
webhook, send real email, charge a card, delete data, or destroy a key, stop and
obtain the separately required explicit user approval.

## Decision Required before production

- **RTO: Decision Required** — choose only after a provider-specific staging
  restore drill measures inventory, restore, verification, and cleanup.
- **RPO: Decision Required** — choose only after
  PostgreSQL/object-storage/wrapped-key snapshot
  consistency and billing/session projection recovery semantics are known.
- **SLO: Decision Required** — choose availability and latency objectives plus
  Issue #217 alert thresholds from measured staging evidence and business needs.
- Production PostgreSQL/object-storage/KMS/backup providers, regions, IAM,
  retention, quota, and restore consistency: Decision Required.
- Telemetry provider, retention, sampling, dashboard, alert routes, and on-call
  ownership: Decision Required.
- Stripe webhook replay procedure, Google/Email provider recovery, canary cohort,
  maintenance window, rollback window, and incident communication owner: Decision
  Required.

Before any production procedure exists, replace provider-neutral placeholders in
an independently reviewed provider adapter/runbook, conduct an approved staging
drill, and obtain legal/security/operations review. This Issue performs no
production operation and changes neither `main` nor production.

## Local verification

Run the focused Go policy and import-boundary tests with:

```sh
go -C backend test ./internal/operations -run 'LaunchPolicy|EnvironmentAction|LaunchGate|ConcreteEffects'
```

Run the retained frontend architecture checks with:

```sh
npx vitest run tests/unit/architecture.test.ts
```

Then run `git diff --check` and `npm run verify`. Reverting Issue #502's pure Go
policy is a repository change only and has no schema, data migration, operation
executor, or external effect to undo. T17 must not be rolled back by restoring
the retired TypeScript server roots; production recovery uses only the reviewed
immutable release units and datastore procedure described above.
