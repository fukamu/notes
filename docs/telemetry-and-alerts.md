# Provider-neutral telemetry and alert contract

Issue #217 defined the telemetry vocabulary used to observe authentication,
Sync V2, billing, encrypted storage, and envelope-crypto boundaries without
exporting user content or tenant identifiers. Issue #503 preserves that frozen
TypeScript contract at
`e8936ab90768774371d84b4808c100d546649943` in typed Go policy before the
legacy server is retired. It does not select or connect a production monitoring
provider.

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
failed outcomes without one. The bounded Go JSON decoder rejects missing,
duplicate, unknown, or trailing fields; malformed UTF-8 or surrogate escapes;
oversized input; and all values outside this vocabulary. Rejection returns one
fixed error and never reflects the rejected value.

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

The frozen TypeScript Sync V2 handler records representative anonymous/CSRF
denial, invalid input, billing lock, dependency/internal failure, expected
application denial, normal success, and no-change outcomes. It records only
mutation/change count buckets and never records request values or authenticated
context identifiers. Issue #503 ports the policy and buffer boundary only; it
does not silently connect a Go HTTP route or a production exporter.

The Go `telemetry.Sink.Record` port is a synchronous buffer boundary with a
typed `buffered`/`dropped` result. A production adapter must enqueue locally and
perform provider I/O outside the request correctness path. `RecordSafely`
recovers sink failure and normalizes backpressure drops. An explicit no-op sink
and deterministic test fake verify ordering, failure isolation, and the fixed
event vocabulary without any provider call.

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
cd backend
go test ./internal/telemetry
```

The Go tests exhaust every operation/outcome/failure-category coherence
combination, exact bucket boundaries, alert precedence, sensitive and
high-cardinality rejection, fixed metric serialization, sink ordering, and
export-failure isolation. Existing `npm run verify` remains the shared gate;
the frozen TypeScript tests continue to run until the reviewed T17 removal.

This contract proves vocabulary, redaction-by-construction, bounded
cardinality, and request-result isolation. It does not prove provider delivery,
retention, sampling, cost, dashboard correctness, alert latency, or notification
delivery. No production monitoring account, secret, destination, or alert is
created by Issue #503. Clocks, request logging, provider export, and notification
delivery remain effect adapters outside the pure event, metric, and alert
policy.

Rollback is a single PR revert of the Go policy, tests, closure evidence, and
this compatibility update. The frozen TypeScript reference remains unchanged;
there is no schema, data, route, provider, or external-resource migration.
