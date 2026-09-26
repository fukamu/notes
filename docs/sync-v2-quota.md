# Sync v2 quota enforcement

> Historical migration-source note: references below to the TypeScript,
> `legacy-test`, Sites, and D1 composition describe the frozen pre-T17 system.
> Current executable policy/application code is Go, with quota state in
> PostgreSQL; route activation is tracked separately from source retirement.

Historically, Issue #196 connected the paid Personal Vault limits and the Vault
quota ledger to the TypeScript authenticated Sync v2 application while
`legacy-test` and Sites still used the local-first v1 path. In the current
source tree, the Go route remains fail closed until an explicit runtime is
composed; there is no Sites/D1 runtime path.

## Enforcement order and boundaries

The HTTP boundary derives `VaultContext` from the verified server session,
decodes a bounded request, authorizes `notes-sync`, and reads the matching
Entitlement limits before calling the application. A denied or unavailable
Entitlement never reaches the quota ledger, encrypted content, or journal.
The measured request byte count and the server-read limits are explicit typed
application inputs; Account or Vault identifiers are never accepted from the
request body.

Each mutation then applies independent checks:

- display characters use the Unicode-scalar policy;
- serialized plaintext is the exact UTF-8 byte sequence passed to encryption;
- the complete versioned ciphertext envelope is checked before object upload;
- active-card and active-card plaintext totals are admitted by the
  Vault-scoped D1 reservation ledger.

Expected failures map to generic no-store responses: request/card/ciphertext
size failures use `413`, Vault capacity uses `409`, and unavailable scope or
quota storage uses `503`. These responses do not expose tenant, key, object, or
billing details.

## Mutation and failure ordering

The mutation UUID is also its quota reservation ID, and the SHA-256 mutation
fingerprint protects both records. The write order is:

1. reserve positive quota capacity with D1 CAS;
2. write or replay the immutable encrypted object;
3. commit or replay the Sync v2 journal receipt;
4. commit the quota reservation.

A failure after reservation leaves it `reserved`; it is not automatically
released. Retrying the same mutation reuses its fingerprint, encrypted write,
and journal receipt, then completes quota finalization without double charging
or re-uploading ciphertext. `reconcileAfter` only marks the reservation for a
future evidence-based reconciliation pass. A reconciler must compare durable
content and journal evidence before explicitly committing or releasing it.

The 10,000-card admission check includes concurrent positive reservations, so
only one of two competing creates can occupy the final slot. Decreasing updates
and deletions do not make capacity available until their journal operation and
quota finalization succeed.

## Update, conflict, and deletion accounting

Card creates and updates account for the exact serialized active-card bytes.
Conflict objects are independently size checked, while the Vault total remains
the documented total of current active-card plaintext. A concurrent conflict
therefore does not count as another active card.

The existing client `PendingMutation` and Sync v2 request wire still contain
only upsert and conflict-resolution mutations. This Issue does not introduce a
new browser deletion protocol. Instead, the composition exposes a typed
`deleteCard` application operation for a later authenticated deletion boundary.
It reads the current encrypted revision, reserves the signed deletion delta,
commits the existing journal tombstone, and only then finalizes the lower card
and byte usage. The operation is idempotent after response loss.

## Rollback and activation

No production migration, backfill, provider connection, or deployment is part
of this Issue. The schema remains the additive migration from #195. Before an
approved production activation, rollback is to keep the v2 route unavailable.
After activation, online mutations must first be stopped; pending reservations
must remain intact for evidence-based reconciliation rather than being deleted
or released by age.

Main is unchanged and production is not deployed by this integration.

## Go and PostgreSQL migration status

Issue #454 connects the Go quota ledger from #450 to the disconnected Go Sync
v2 application. The Go order is the same reservation, immutable encrypted
write, journal receipt, and finalization sequence documented above. A real
PostgreSQL/encrypted-object vertical test interrupts the journal boundary,
observes the still-reserved capacity, and proves an identical request resumes
without another encryption or object upload. It also proves deletion commits
the tombstone before active-card usage is reduced and that response-loss replay
does not reduce it twice.

The exact 10,000-card concurrent final-slot test remains at the shared
PostgreSQL ledger boundary used by this application. The Go HTTP handler is
still unmounted, so these checks do not enable quota enforcement for the
existing v1 route or publish the paid v2 path.
