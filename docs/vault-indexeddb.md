# Vault-scoped IndexedDB boundary

Issue #113 adds the local storage boundary used by authenticated personal
Vaults. It does not mount authentication in the current application and does
not migrate or delete existing local data.

## Namespace and ownership

The application receives `AccountId` and `VaultId` only through a verified
session's `VaultContext`. `VaultNotesScope` carries those branded identifiers
to the composition root. The pure `notesDatabaseName` function maps that scope
to this versioned namespace:

```text
fukamu-notes:v1:vault:<AccountId>:<VaultId>
```

The session ID and epoch are deliberately absent, so a legitimate session
rotation continues to use the same offline replica. Both account and Vault are
included for defense in depth. No ownership field is added to `CardRecord`,
card bodies, mutations, conflicts, or the v1 wire format.

The unauthenticated compatibility runtime still uses exactly
`fukamu-notes`. Production starts with an empty Vault database; this boundary
does not copy the legacy local database or current Sites/D1 data.

## Connection and deletion semantics

The browser adapter keeps a registry keyed by the derived database name. It
can reuse connections only within the same namespace; different Vaults cannot
share a promise or `IDBDatabase`. A version change closes and forgets the
managed connection. Explicit close removes only the selected namespace, after
which it can be opened again.

Deletion first closes the managed connection and returns a discriminated
result. `deleted`, `blocked`, and adapter failure are distinct. In particular,
`blocked` never means logout succeeded. Issue #144 defines the crash-resumable
pure progress, #147 coordinates tabs, and #148 consumes this result in the
browser purge composition. Until #148 is integrated, the Vault repository is
not connected to a production login flow.

## Verification and rollback

Unit tests open two repositories with the same CardId and verify independent
cards, mutations, conflicts, and device metadata. They also cover per-Vault
connection reuse, close/reopen, blocked deletion, adapter failure, and the
legacy fixed database. Architecture tests keep namespace derivation free of
browser effects and keep tenant identifiers out of content records.

Rollback removes the Vault factory and registry while leaving the legacy
runtime intact. There is no production schema, provider, deployment, or data
migration in this Issue.
