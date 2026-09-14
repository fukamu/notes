# Local server load verification

Issue #216 adds a reproducible, local-only load harness for the authenticated
Sync V2 HTTP boundary. It provides correctness evidence at the expected peak of
1,000 concurrent users without contacting Cloudflare, Stripe, a mail provider,
or any other remote service.

## Safety boundary

Run the harness with:

```sh
npm run benchmark:server-load
```

The only supported execution mode is the in-process `local-fake` mode. The
runner fails before creating traffic when `FUKAMU_SERVER_LOAD_MODE` names
another mode, `FUKAMU_SERVER_LOAD_TARGET_URL` is present, or
`FUKAMU_SERVER_LOAD_CREDENTIAL` is present. The runner has no remote transport
adapter and does not read application or provider credentials.

The test calls the real authenticated `/api/v2/sync` HTTP handler, including
cookie/session scope derivation, CSRF origin checks, entitlement checks, request
decoding, application dispatch, and response encoding. Session, application,
object-storage, KMS, and partition behavior below the HTTP boundary use
deterministic fakes. Consequently, the artifact is not a Cloudflare, D1, R2, or
production SLO measurement.

## Scenarios and required invariants

Each wave starts 1,000 promises before waiting for any response. The artifact
must report `maximumInFlight: 1000` and zero tenant-scope violations.

| Scenario              | Shape                                                            | Required result                                                                                      |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `cold-start`          | 1,000 users and 1,000 independently composed HTTP handlers       | all 1,000 responses succeed; 1,000 Vaults stay isolated                                              |
| `normal-poll`         | 1,000 users through one handler and 16 simulated partitions      | all 1,000 no-change polls succeed; object and KMS calls remain zero                                  |
| `hot-vault-partition` | 1,000 requests against one Vault and one partition               | all requests succeed without scope confusion; object and KMS calls remain zero                       |
| `response-loss-retry` | 1,000 mutations commit once, lose the first response, then retry | first responses are unavailable, retries succeed, and exactly 1,000 commits plus 1,000 replays occur |

The response-loss fake records one object write and one KMS encryption for the
first durable commit. A retry is accepted only when it replays the receipt
without a second write or encryption. The no-change scenarios reject any
object read/write or KMS encrypt/decrypt count above zero.

## Baseline result

[`benchmarks/server-load-local.json`](benchmarks/server-load-local.json) records
the host information, raw scenario counts, observed durations, and memory
deltas from the Issue #216 branch point
`78a77aadbcc29aa628f25be287ece307acebf70d`.

The correctness counts are required test assertions. Duration, heap delta, and
RSS delta are observations only: host contention and garbage collection make an
absolute wall-clock or memory threshold unsuitable for this local harness. No
5-second or other unsupported timing gate is introduced.

The checked-in artifact is decoded and re-evaluated during `npm run verify`, so
missing scenarios, malformed fields, tenant violations, duplicate commits, or
unexpected no-change adapter calls fail the existing test gate. Re-running the
benchmark intentionally refreshes observational values in the artifact; review
that diff before committing it.

## Rollback and limitations

Rollback removes the benchmark command, Vitest configuration, support/tests,
this document, and the checked-in artifact. It does not require a schema or data
migration.

This harness does not authorize or replace provider-scale load testing. Actual
Cloudflare/D1/R2/KMS testing, production credentials, paid services, staging or
production traffic, and SLO selection remain outside Issue #216 and require
their applicable approvals.
