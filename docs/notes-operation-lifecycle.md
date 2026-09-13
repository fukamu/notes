# Notes operation lifecycle boundary

Issue #143 prevents asynchronous work started by an old notes runtime from
crossing a logout, unmount, session rotation, or Vault switch. It composes with
the Vault-scoped repository from #113 and does not add authentication, billing,
or a production provider to the local application.

## Trusted token and pure decision

The lifecycle starts in `stopped` and is explicitly activated by the mounted
`NotesProvider`. Every activation advances a local operation epoch. A load,
save, or sync captures a token containing:

- operation kind;
- operation epoch;
- AccountId, VaultId, SessionId, and SessionEpoch for an authenticated scope;
  or the exact legacy compatibility scope.

`decideNotesOperationContinuation` is a typed pure function. It accepts only a
token from the current active generation and exact trusted scope. It returns a
discriminated rejection reason for a stopped lifecycle, changed scope, or
changed operation epoch. It does not inspect a request or response for tenant
identity and does not use React, Promise, clocks, UUID generation, fetch, or
storage.

## Effect checkpoints

The client composition checks the token after every asynchronous repository or
transport step. In particular, it checks a sync token after the network
response and before `applySyncResponse`. A response that arrives after logout
therefore cannot acknowledge mutations or advance a future cursor. State is
checked again after repository application before visible cards or conflicts
are replaced.

Queued saves check their captured token before starting the repository write
and after it completes. Once a runtime stops, later queued writes, save-state
updates, and follow-up sync timers are discarded. A running sync is owned by
its token, so an old completion cannot clear the running marker of a newer
runtime generation.

The repository remains scope-bound. Browser storage operations already in a
low-level transaction cannot always be cancelled at the JavaScript boundary;
they can affect only the old Vault namespace and cannot be redirected to a new
repository. Issue #144 owns crash-resumable progress decisions, #147 owns tab
coordination, and #148 owns worker shutdown and deletion of that old namespace.

The #147 runtime fence applies the lifecycle stop in a React layout effect
before its passive effect releases the shared Vault runtime Web Lock. A purge
owner can therefore acquire its exclusive runtime lock only after old Provider
operations have been fenced. Browser data deletion remains #148.

## Compatibility, verification, and rollback

The same active generation still accepts ordinary autosave and sync. Visible
card reconciliation continues to preserve an edit made while a sync request is
in flight. The explicit `LegacyNotesApp` receives the same guard using its
fixed scope, so local development and E2E do not require Google, email, Stripe,
or production infrastructure.

Pure tests cover all operation kinds and every Vault/session identity field.
Provider integration tests use an in-memory DOM and deferred adapter promises
to cover late load, in-flight sync, queued save, unmount, session rotation,
Vault switch, and current-session edit rebase. Existing IndexedDB and malformed
sync tests continue to prove decode-before-write and mutation retention.

Rollback removes the lifecycle and Provider checkpoints without changing a
schema or data. The #113 storage namespaces remain independently usable. No
production service, deploy, payment, email, key, or data operation is part of
this Issue.
