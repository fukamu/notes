# Provider-neutral telemetry and alert contract

Issue #217 defines the telemetry vocabulary used to observe authentication,
Sync V2, billing, encrypted storage, and envelope-crypto boundaries without
exporting user content or tenant identifiers. It does not select or connect a
production monitoring provider.

## Data contract

Every event contains only five bounded dimensions plus `schemaVersion: 1`:

| Dimension         | Fixed values                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| operation         | Google OIDC, Email OTP, Sync V2, Stripe billing, encrypted-object storage, envelope crypto                    |
| outcome           | success, no-change, replayed, denied, locked, failure                                                         |
| failure category  | none, authentication, authorization, invalid-input, billing, quota, conflict, dependency, integrity, internal |
| duration bucket   | not measured, under 10 ms, 10–99 ms, 100–999 ms, 1 second or more                                             |
| work-items bucket | not measured, zero, one, 2–10, 11–100, 101–1,000, over 1,000                                                  |

Raw durations and counts are converted to buckets before recording. A pure
invariant rejects successful outcomes with a failure category and rejected or
failed outcomes without one. The unknown-value decoder rejects unknown fields
and all values outside this vocabulary.

The powers-of-ten duration and count boundaries are stable aggregation bins for
bounded cardinality, not pass/fail targets or alert thresholds. Changing their
meaning requires a telemetry schema-version review.

Three provider-neutral metric samples are derived from an event:

- `boundary-outcome-total`
- `boundary-duration-bucket-total`
- `boundary-work-items-bucket-total`

Their values are always `1`; their labels are subsets of the bounded event
dimensions. There is no free-form label map.

## Privacy and cardinality boundary

Events and metric labels cannot contain title, body, link, conflict content,
keys, OTPs, tokens, cookies, payment/customer details, or raw AccountId,
VaultId, CardId, SessionId, and mutation identifiers. Tests submit sensitive
markers, a raw Vault identifier, arbitrary operations, and incoherent states to
the decoder and require rejection.

The Sync V2 HTTP handler records representative anonymous/CSRF denial, invalid
input, billing lock, dependency/internal failure, expected application denial,
normal success, and no-change outcomes. It records only mutation/change count
buckets; it never records request values or authenticated context identifiers.

`TelemetrySink.record` is a synchronous buffer boundary with a typed
`buffered`/`dropped` result; a Promise-returning exporter does not satisfy the
port. A production adapter must enqueue locally and perform provider I/O
outside the request correctness path. `recordTelemetrySafely` catches sink
failure and normalizes backpressure drops, and the Sync V2 tests verify that
such a failure does not change a successful HTTP response. An explicit no-op
sink and deterministic fake sink support local development and tests.

## Alert contract

The pure alert planner emits only an alert candidate:

| Signal                   | Route class         | Example evidence                                   |
| ------------------------ | ------------------- | -------------------------------------------------- |
| integrity failure        | security operations | encrypted storage or crypto authentication failure |
| service failure          | service operations  | dependency/internal failure                        |
| billing lock             | billing operations  | entitlement lock                                   |
| billing provider failure | billing operations  | Stripe transport or provider failure               |

Every candidate has `threshold: decision-required`. This prevents Issue #217
from silently choosing an SLO, notification frequency, pager destination, or
provider-specific query. Authentication denials and normal expected denials do
not page per event; abuse-window thresholds remain a production decision.

Issue #218 may reference these stable signal and route names in launch/runbook
gates. Production thresholds must be chosen from measured staging evidence and
business availability/security requirements, then approved before a provider
adapter or live alert is configured.

## Verification and operational limits

Run focused verification with:

```sh
npx vitest run tests/unit/telemetry-core.test.ts tests/unit/sync-v2-http-handler.test.ts tests/unit/architecture.test.ts
```

The fake sink tests ordering, success/denial/failure/no-change events, and
export-failure isolation. Existing `npm run verify` remains the shared gate and
includes the telemetry server modules in the existing `server/**/*.ts`
coverage target.

This contract proves vocabulary, redaction-by-construction, bounded
cardinality, and request-result isolation. It does not prove provider delivery,
retention, sampling, cost, dashboard correctness, alert latency, or notification
delivery. No production monitoring account, secret, destination, or alert is
created by Issue #217.

Rollback is a single PR revert: remove the telemetry core/public/fake modules,
Sync V2 recording calls, tests, and this document. There is no schema or data
migration.
