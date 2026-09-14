# Contract offer snapshot and consent evidence

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

The D1 repository keys every lookup and write by Account and Vault. Repeating
the same scoped submission with identical terms is a replay; reusing an
identifier for different terms is a conflict. The schema permits no UPDATE,
and production migrations are explicit rather than request-time DDL. Stored
JSON and metadata are decoded and cross-checked before entering the domain.

The in-memory repository and Web Crypto hasher are explicit adapters for tests
and local composition. They do not enable billing or grant access, and no
production provider fallback is introduced.

## Deletion, retention, and rollback

Contract evidence is live Account/Vault data. Its foreign key uses `ON DELETE
CASCADE`, so the existing account-deletion saga removes it with the Personal
Vault as required by the product deletion contract. While the account is live,
the application exposes append/read behavior only and the database rejects
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

Focused unit and Miniflare tests cover authoritative derivation, stable hashing,
consent and stale-offer rejection, replay and race behavior, cross-Vault
isolation, immutable rows, malformed-row fail-closed behavior, migration order,
and account-deletion cascade. The repository-wide required gates remain:

```bash
git diff --check
npm run verify
```
