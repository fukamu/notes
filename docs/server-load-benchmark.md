# Local server load verification

Issue #501 replaces the legacy TypeScript harness from Issue #216 with a
deterministic Go regression test for the authenticated Sync v2 HTTP boundary.
It provides correctness evidence for 1,000 concurrent requests without making
a production-capacity claim or contacting a hosted database, KMS, object store,
Stripe, mail provider, or any other remote service.

## Safety boundary

Run the harness with:

```sh
npm run benchmark:server-load
```

The only supported execution mode is `local-go-postgres`. The database URL is
validated by `ValidateTestDatabaseURL`: only a loopback host and the dedicated
`fukamu_notes_go_test` database are accepted. The runner fails before creating
traffic when `FUKAMU_SERVER_LOAD_MODE` names another mode,
`FUKAMU_SERVER_LOAD_TARGET_URL` is present, or
`FUKAMU_SERVER_LOAD_CREDENTIAL` is present. It has no remote HTTP transport and
does not read application or provider credentials.

The test calls the real Go `/api/v2/sync` contract handler and Go Sync v2
application. Cookie/session resolution, tenant ownership, the journal, quota,
encrypted-object metadata, and durable replay state use an isolated PostgreSQL
schema. Entitlement is an injected deterministic decision, while object storage,
data-key unwrap, nonce reservation, and encryption use concurrency-safe in-memory
adapters. Consequently, this is not a provider, network, or production SLO
measurement.

## Scenarios and required invariants

Each wave admits 1,000 goroutines before releasing any request to the handler.
The evidence must report `maximumInFlight: 1000`, while the PostgreSQL pool is
bounded to 16 connections and application execution is serialized after the
concurrent HTTP/session boundary. This mirrors the single-threaded legacy
application fake while making PostgreSQL results independent of scheduler
interleavings. Every scenario requires zero tenant-scope violations.

| Scenario              | Shape                                                            | Required result                                                                                                 |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cold-start`          | 1,000 users and 1,000 independently composed HTTP handlers       | all 1,000 responses succeed; 1,000 Vaults stay isolated                                                         |
| `normal-poll`         | 1,000 users through one handler and 16 simulated partitions      | all 1,000 no-change polls succeed; object and KMS calls remain zero                                             |
| `hot-vault-partition` | 1,000 requests against one Vault and one partition               | all requests succeed without scope confusion; object and KMS calls remain zero                                  |
| `response-loss-retry` | 1,000 mutations commit once, lose the first response, then retry | first responses are unavailable, retries succeed, and exactly 1,000 PostgreSQL commits plus 1,000 replays occur |

The response-loss adapter replaces the first successful, fully committed Go
application result with an unavailable response. The mutation request carries
an authenticated cursor positioned at the sequence committed by that request,
so it can verify receipt replay without hydrating the newly written object. A
retry is accepted only when PostgreSQL still contains exactly one commit per
mutation and the in-memory adapters report no second object write or encryption.
The real encrypted-object write protocol performs one not-found object probe
before each first write, so the retry scenario requires exactly 1,000 object
reads in total; any replay read is a failure. The no-change scenarios reject any
object read/write or encrypt/decrypt call above zero.

## Baseline result

[`benchmarks/server-load-go.json`](benchmarks/server-load-go.json) records the
deterministic scenario counts from the Issue #501 branch point
`b95a8155efabe4a29ddafb01b62d7190b926c208`. The test decodes the checked-in
file with unknown fields rejected, executes every scenario in order, and
requires an exact match. It also queries PostgreSQL after the run for 1,000
distinct durable commits, encrypted objects, committed quota reservations, and
active cards.

The correctness counts are required test assertions. Duration and memory remain
observations only: host contention, PostgreSQL scheduling, and garbage
collection make absolute wall-clock or memory thresholds unsuitable for this
local harness. They are deliberately not persisted, and no unsupported timing
gate is introduced.

`npm run verify` runs the Go integration suite, including this regression test.
`npm run benchmark:server-load` runs only the focused evidence test. The
checked-in counts do not change when the benchmark is re-run.

## Retired legacy assertion mapping

T17 removed the TypeScript harness after freezing its source and test ledger at
the revisions recorded in
[`legacy-typescript-retirement.md`](legacy-typescript-retirement.md). The
historical assertions map to the executable Go evidence as follows:

| Legacy evidence                                         | Go replacement                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1,000 started promises and `maximumInFlight`            | 1,000 admitted goroutines released as one wave; application dispatch is serialized like the legacy single-threaded fake                                            |
| cookie/session fake                                     | PostgreSQL-backed Go `SessionResolver` plus the real CSRF/session boundary                                                                                         |
| application call, Vault, partition, and tenant counters | a synchronized observer around the real Go Sync v2 application                                                                                                     |
| synthetic commit and response loss                      | real encrypted-object, quota, and journal commits followed by injected response loss                                                                               |
| object/KMS fake call counts                             | concurrency-safe memory object storage and counted in-memory encryption adapter; one required not-found probe per real Go write is asserted separately from replay |
| unique commits and replays                              | exact counters plus durable PostgreSQL row and ownership checks                                                                                                    |
| host timing and memory deltas                           | intentionally non-gating and omitted from deterministic evidence                                                                                                   |

## Rollback and limitations

Rollback of the Go load evidence restores its prior commit only as part of a
reviewed migration rollback. The retired TypeScript files are not a deployable
fallback; their exact Git revisions and digests remain historical evidence.
No schema or production data operation is performed by this benchmark.

This harness does not authorize or replace provider-scale load testing. Hosted
PostgreSQL, Cloudflare, KMS, object-storage, production credentials, paid
services, staging or production traffic, capacity statements, and SLO selection
remain outside Issue #501 and require their applicable approvals.
