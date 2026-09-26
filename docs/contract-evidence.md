# Contract offer snapshot and consent evidence

The TypeScript/D1 and Sites sections below are historical compatibility
evidence. T17 removed that server source and tooling. The executable contract
service, closed Go HTTP boundary, PostgreSQL adapter, and schema now live under
`backend/internal/legal`, `backend/internal/httpapi`, and `backend/migrations`.

Issue #223 introduces the provider-neutral record used to prove which approved
commercial terms a customer affirmatively accepted. It does not add a checkout
route, Stripe call, dialog, or Notes-screen element. The dedicated checkout and
account surfaces in #224 and #225 will consume its public contract; the normal
card editor, history, and connections UI remain unchanged.

## Authoritative offer

`planContractOffer` derives a versioned snapshot from the same strictly decoded
legal-commerce disclosure used by `/pricing` and
`/legal/commercial-transactions`. The client cannot supply the Account, Vault,
price, billing period, trial, renewal, cancellation, refund, or lock policy.
Those values are server-derived before hashing.

The canonical snapshot records the one-Personal-Vault quantity, tax-inclusive
price, billing period, 14 free days, first automatic charge on day 15, renewal
charge, annual estimate, automatic renewal, credit-card method, service period,
cancellation and refund text, and payment-failure lock policy. Its stable JSON
serialization is hashed with SHA-256 through `ContractOfferHasherPort`.

The exact calendar date of the first charge is intentionally not guessed before
checkout completes. #224 preserves the relative day-15 rule in the provider
mapping. #225 must show the approved rule at the final-action surface and must
not claim an exact provider date until a Stripe test-mode rendering or completed
provider result proves it. A redirect alone is never evidence of consent or
entitlement.

## Confirmation and idempotency

A confirmation command contains only a UUIDv7 submission identifier, the hash
the server presented, and a discriminated affirmative-consent value. The
application service receives `VaultContext`, evidence identifier, and clock
value from trusted outer adapters. It rejects missing consent, a stale hash,
malformed values, owner mismatch, and identifier conflicts.

The current Go PostgreSQL repository keys every lookup and write by Account and
Vault. Repeating the same scoped submission with identical terms is a replay;
reusing an identifier for different terms is a conflict. It exposes only
append and scoped reads, and the embedded PostgreSQL migration rejects UPDATE
with an immutable trigger. Stored JSON and metadata are decoded and
cross-checked before entering the domain; request handlers never run DDL.

Historically, ChatGPT Sites applied a Drizzle/D1 migration that could not
preserve the multi-statement trigger body. That behavior is compatibility
evidence only: T17 removed its runner, schema, and repository, and no current
Sites application path exists in this source tree.

The Go in-memory repository and hash adapter are explicit local/test adapters.
They do not enable billing or grant access, and no production provider fallback
is introduced.

## Deletion, retention, and rollback

Contract evidence is live Account/Vault data. The historical TypeScript/D1
foreign key used `ON DELETE CASCADE`, so its account-deletion saga removed it
with the Personal Vault. The Go PostgreSQL migration intentionally does not copy
that implicit cascade: its
foreign key blocks owner deletion until T12 executes a reviewed explicit
deletion/retention workflow. This is a safety hold, not a decision to retain the
evidence indefinitely. While the account is live, both application repositories
expose append/read behavior only and their production-grade migrations reject
mutation by UPDATE.

Whether Japanese corporate, tax, or dispute-handling obligations require a
separate minimised record after account deletion is a production Decision
Required. Such a record must have its own lawful purpose, fields, retention
period, access controls, and deletion schedule; this Issue does not silently
retain the Personal Vault evidence for that purpose.

Before any production application, rollback is a PR revert and recreation of a
disposable local/test database. After evidence exists, rollback must stop new
submissions without rewriting or deleting live evidence. Destructive production
migration, real payment-provider use, deployment, and main integration require
separate explicit approval.

## Verification boundary

The retired Miniflare tests are preserved only in the frozen ledger/revision.
Current Go unit and disposable-PostgreSQL tests cover authoritative derivation,
stable hashing, consent and stale-offer rejection, exact ownership, replay and
race behavior, cross-Vault isolation, immutable rows, malformed-row fail-closed
behavior, migration order, and the explicit deletion hold. The repository-wide
required gates remain:

```bash
git diff --check
npm run verify
```
