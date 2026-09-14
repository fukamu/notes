# Privacy processing registry and consistency gate

Issue #230 introduces a provider-neutral inventory for personal-data processing.
It is an engineering control, not a provider selection, transfer decision, legal
opinion, or authorization to configure production services.

## Stable data categories

The registry uses IDs rather than matching translated display text:

| Category ID               | Current product boundary                                                  | Required lifecycle evidence                                           |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `account-identity`        | Account, linked Google/Email identity, contact attributes                 | Approved account/identity retention                                   |
| `authentication-security` | Session metadata, OTP challenge/hash and abuse controls                   | Session revoke/expiry and OTP expiry                                  |
| `billing-contract`        | Subscription/entitlement state, provider references and contract evidence | Approved contractual/statutory retention                              |
| `vault-content`           | Encrypted card content plus scoped metadata                               | Account-deletion live purge and backup expiry at no more than 30 days |
| `device-offline-replica`  | Vault-scoped IndexedDB/offline state                                      | Logout local purge                                                    |
| `operational-audit`       | Redacted security, reliability and request evidence                       | Approved operational/audit retention                                  |

Each registry entry lists typed sources, purposes, systems, and retention
policies. Processor entries refer only to declared categories and purposes. This
does not add AccountId or VaultId to `CardRecord`; tenant ownership remains the
responsibility of server session-derived `VaultContext` and scope-bound
repositories.

## Provider decisions

The required roles are hosting/database/object storage, Google identity, email
delivery, subscription billing, and key management. Local/CI uses a checked-in
fixture whose roles are all `decision-required`. The pending form stores no
invented legal entity, country, legal role, transfer basis, safeguard, or
subprocessor.

A production entry must instead be `verified` and contain its legal name, legal
role, country list, HTTPS privacy/subprocessor references, and either a reviewed
domestic-only state or reviewed cross-border summary/safeguards. These fields
are provider-neutral records and do not call a provider API.

The Personal Information Protection Commission's current general and
foreign-transfer guidance is the primary engineering reference for purpose
specificity, processor supervision and context-dependent transfer information:

- https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/
- https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/

Provider contracts, locations and legal characterization must be verified with
the selected provider and a qualified Japanese lawyer before production.

## Build and drift gates

`legacy-test` resolves the pending local fixture without network access.
`public-paid` requires `FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON`. Its unknown JSON
boundary rejects missing/unknown fields, unsupported IDs, duplicate entries,
bad dates, insecure URLs, undeclared purpose/category references, and lifecycle
drift. Production additionally rejects every `decision-required` retention or
processor and placeholder text.

`npm run build` executes `check:privacy-processing-registry` after the privacy
disclosure gate. The combined gate checks that:

- all stable categories are disclosed and registered;
- session and OTP records have expiry/revocation policies;
- Vault live content participates in account deletion;
- backup expiry remains at no more than 30 days;
- the device replica participates in logout purge;
- processor categories and purposes are present in the data inventory.

This is a completeness/drift check, not legal approval or production authority.

## Scope and rollback

There is no D1/R2/KMS/Stripe operation, provider call, schema migration, real
email, deployment, or production data change. Runtime processors are not
configured. The change is reversible as one PR containing the typed vocabulary,
registry/resolution core, environment adapter, build gate, tests and docs.
Rollback must not weaken the already implemented logout/account-deletion
behavior or erase any later accepted data-subject request.
