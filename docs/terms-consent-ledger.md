# Terms consent ledger

Issue #243 adds the provider-neutral persistence boundary for evidence that a
specific Account and Personal Vault affirmatively accepted one immutable
version of the FUKAMU Notes terms. It is separate from `contract_evidence`,
which records the commercial offer confirmed before checkout; neither record is
treated as a substitute for the other.

## Contract and pure decision

`server/terms-consent/public.ts` brands consent and submission UUIDv7 values,
the `terms-v1:YYYY-MM-DD` version, and the lowercase SHA-256 document hash. A
record keeps the complete decoded disclosure, its deterministic serialized
snapshot, the version and hash, the affirmative marker, and the caller-supplied
acceptance timestamp. It stores no email address, session token, payment method,
or Notes content.

`planTermsConsentSnapshot` decodes an external disclosure and produces its
canonical serialization. `planTermsConsent` is independent of D1, clocks,
UUID generation, HTTP, and the DOM. It rejects missing consent, a stale
version/hash, malformed snapshot metadata, a repository result from another
Vault, and reuse of a submission identifier with changed version, hash, or
snapshot. An exact submission replay returns the original record.

## Scoped adapters and schema

The repository port accepts a server-derived `VaultContext`; AccountId and
VaultId are never command fields. The D1 and in-memory adapters key every ID
lookup by both AccountId and VaultId. The latest-evidence index begins with the
same tenant scope.

Migration `0015_terms_consent_ledger` creates a fresh empty table after the
privacy request journal. A composite owner foreign key rejects unknown Vaults
and cascades live evidence when that Personal Vault is deleted. Scoped primary
and submission keys make insert replay and identifier collision distinguishable.
The explicit production migration adds a trigger that rejects all `UPDATE`
statements; its manifest is checksum-pinned and no request handler performs DDL.

ChatGPT Sites cannot reliably apply multi-statement trigger bodies, so its
checked-in `drizzle` migration creates the table and indexes without that
trigger. The Sites repository remains INSERT/SELECT-only and architecture tests
reject application SQL that directly UPDATEs or DELETEs either legal evidence
table. A D1 administrator can still bypass that application boundary in the
Sites test environment; production keeps the trigger as defense in depth.

## Failure, rollback, and retained decisions

Unknown or internally inconsistent D1 rows fail closed at the record codec.
D1 failures do not produce an accepted result or a plaintext/log fallback.
Rolling back application use stops new acceptance but does not drop the ledger
or delete evidence already collected. The production migration is not applied
by this Issue.

The legally appropriate audit-retention period and any narrow post-withdrawal
retention exception remain subject to Japanese legal review. Until a separately
approved policy changes the data lifecycle, deleting the owning Personal Vault
deletes this live tenant record. This Issue adds no HTTP route, signup or
checkout wiring, dialog, banner, checkbox, or other Notes UI.
