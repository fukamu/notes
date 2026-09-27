# Sync v2 client runtime

> Historical composition note: references below to `LegacyNotesApp`, the
> TypeScript server, Sites, and D1 describe the pre-T17 runtime. The browser
> client remains TypeScript, while request-time server execution and durable
> server persistence are Go/PostgreSQL. Issue #511 now connects the full route
> only inside the isolated local-fixture profile.

Issue #122 connects the authenticated Vault browser runtime to the incremental
Sync v2 protocol and the transactional local replica introduced by #165. It
does not enable production providers or change the local legacy application.

## Runtime separation

In the historical composition, the runtime sync dependency was a discriminated
union and `LegacyNotesApp` constructed the fixed legacy scope with the v1
`/api/sync` transport. That is compatibility history, not a remaining
TypeScript server or Sites deployment path.

The live local-fixture `SessionNotesApp` constructs
`createVaultNotesRuntimePorts` from its server-derived `VaultContext`. That
factory binds a per-Vault IndexedDB repository to the v2 `/api/v2/sync`
transport. The Vault runtime type only permits v2, so a public paid runtime
cannot silently fall back to the unauthenticated v1 endpoint.

The production v2 route remains fail-closed with HTTP 503 until real encrypted
content providers are approved and composed. No production deployment is part
of this Issue.

## Page and commit boundary

The application client atomically moves eligible drafts into one durable
outgoing batch before the request, then loads the persisted checkpoint. The
same batch ID, device ID, mutation IDs, bases, and content are reused across
pages, response-loss retries, reloads, and competing tabs. Edits saved after
capture remain separate drafts; they never replace the outgoing payload. Each
response is decoded by the pure page planner. Cursor mismatch, a non-advancing
cursor, sequence reordering, a changed high-watermark, changed receipts, or
malformed data rejects the attempt.

Only a valid terminal page produces a replica commit. The #165 adapter then
updates cards, draft mutations, conflicts, the outgoing batch, and the
checkpoint in a single IndexedDB transaction. It clears an outgoing batch only
when the transaction sees the expected batch ID and receipts for every mutation
in that batch. A lost response or malformed intermediate page therefore keeps
both the checkpoint and exact request payload available for an idempotent
retry.

When input continues during the request, a draft records the mutation ID it
causally follows. A receipt rebases only that successor, only to the receipt's
exact applied revision, and only when the collected changes contain the matching
server card content. A later revision from another device may still update the
local replica, but it cannot become the draft's base silently; sending that
draft preserves the genuine conflict. An eligible successor triggers an
immediate follow-up sync after the outgoing batch commits.

## Session epoch and visible edits

`NotesProvider` supplies a current-operation predicate backed by the active
scope and operation epoch. The v2 client checks it after checkpoint load, after
each HTTP response, immediately before the terminal transaction, and after the
transaction. A logout fence, unmount, session rotation, or Vault switch makes
the operation stale and prevents later effects from being exposed to the UI.

After a successful commit, the existing visible-card reconciler preserves an
edit made while the request was in flight while retaining the server display ID
and revision progress. Existing autosave, offline editing, conflict resolution,
URL behavior, and presentation remain shared with the v1 runtime.

Issue #307 also treats absence from the successfully committed replica as a
confirmed deletion for a card that has not changed since the request snapshot.
Such a card is no longer appended back into the visible state after its
IndexedDB record was removed. A card created during the request, or an existing
card whose local revision advanced during the request, is still retained. This
uses the same request-revision snapshot for v1 and v2 reconciliation; it does
not change the wire protocol, checkpoint, transaction, or pending-mutation
rules.

## Rollback

The local connection can be reverted by stopping the fixture and removing the
v2 Vault composition/bootstrap. The legacy factory remains compatibility code,
but rollback must not route authenticated data through v1. Existing Vault
checkpoints and server journal/ciphertext/quota state must be preserved as one
consistency set; storage schema rollback and checkpoint handling belong to
#165.
