# Crash-resumable logout purge core

Issue #144 defines the durable decisions shared by the later multi-tab and
browser cleanup adapters. It does not connect logout to the current route and
does not use production identity, storage, worker, or billing services.

## Durable progress

The versioned `logout-purge/v1` marker contains only the branded AccountId,
VaultId, SessionId, SessionEpoch, current target, attempt, revision, and typed
failure reason. It cannot contain card content, conflict data, an OTP, a key,
or a session token. External marker values are decoded from `unknown`; missing,
corrupt, and unsupported-version markers remain distinct.

The logout generation is all four trusted identity/session values. Events from
another account, Vault, session, or session epoch cannot advance progress. The
revision is used by the progress port for compare-and-swap writes, preventing a
stale coordinator from overwriting a concurrent owner.

## Ordered targets and completion

The pure state machine requires these targets in order:

1. runtime fence;
2. peer tabs;
3. local runtime;
4. graph worker;
5. Service Worker cache;
6. Vault database;
7. deletion verification.

Each target must transition from `pending` or a typed retryable `failed` state
to `running`, then report success before the next target is exposed. Blocked,
timeout, adapter failure, unsupported capability, and verification failure do
not count as success. A crash converts persisted `running` work into an
explicit `interrupted` failure for the same target and attempt history.

There is deliberately no durable `completed` marker. Final verification
returns `ready-to-clear`; only a successful compare-and-swap clear means logout
purge completed. If clear fails or the browser crashes, the last `running`
marker remains and idempotent verification must run again. Notes runtime is
allowed only when the progress boundary proves that no marker exists. Invalid,
unknown, or unreadable progress fails closed.

## Ports and follow-up ownership

The application port exposes only `read`, CAS `write`, and conditional `clear`.
It treats non-boolean adapter results and thrown failures as unavailable. The
in-memory fake adapter exercises persistence failure, concurrent revision,
reload resume, and final clear without becoming a production fallback.

Issue #147 owns BroadcastChannel/Web Locks, peer acknowledgement, and runtime
fencing composition. Issue #148 owns the browser progress adapter, IndexedDB,
Service Worker, graph worker, navigation, and logout E2E. Until both are
integrated, the current `LegacyNotesApp` remains the explicit local harness and
does not require authentication or billing.

## Verification and rollback

Pure tests cover every target, failure kind, generation field, invalid ordering,
counter exhaustion, codec state, and runtime gate. Integration tests cover CAS
persistence, crash recovery, write/clear failure, concurrent progress, and
verified final removal. Architecture tests keep browser effects out of the
core and prevent production composition from importing the fake.

Rollback removes only this unused core/port/fake. It changes no server or
production schema and performs no data deletion, deploy, payment, email, or key
operation. #113 Vault storage and #143 stale-operation protection remain.
