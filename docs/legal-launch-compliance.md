# Japan production launch compliance gate

Issue #135 adds a fail-closed production release check without changing the
normal Notes interface, contacting a provider, or authorizing a deployment.
The machine-readable source is
[`launch-compliance.ts`](../lib/application/launch-compliance.ts). It contains
only fixed requirement states and repository or approved-system references;
secrets, personal data, raw provider output, credentials, tenant identifiers,
and payment details must not be stored there.

This engineering checklist does not replace advice from qualified Japanese
legal, tax, privacy, telecommunications, security, or payment professionals.
Their evidence remains required where the checklist says `pending`.

## Two separate checks

`npm run check:launch-compliance` validates the strict manifest, the approved
JPY 980 tax-inclusive monthly offer, policy version drift, and documentation
links. It is part of the ordinary build and is allowed to succeed while the
production launch is explicitly blocked. This keeps local development and the
owner-only Sites test environment usable.

`npm run check:production-launch` evaluates every required item using the
current UTC date and exits unsuccessfully when evidence is missing, not yet
valid, or expired. A production release workflow must run this command in
addition to the existing build, tests, operational launch gate, review, and
separate deployment approval. Passing it is evidence only; it never deploys,
updates `main`, calls a provider, sends email, charges a card, or mutates data.

## Evidence lifecycle

Each requirement has one of three states:

- `automated`: a versioned repository control is checked on every build.
- `pending`: production is blocked and the reason remains visible.
- `verified`: an external approved-system reference, evidence version,
  verification date, and expiry date are required.

An external reviewer supplies evidence as `unknown`; it must be represented in
the strict manifest before evaluation. A verification date after the check date
is not yet valid. An expiry date before the check date is expired. The expiry
date itself remains valid through that date. Replacing a `pending` entry requires
review of the actual artifact; changing the word to `verified` is not evidence.

The current manifest intentionally blocks public production launch for real
operator/contact values, version archives, Japanese legal and tax review,
telecommunications assessment, Email OTP provider selection, approved GCP Cloud
KMS production configuration, Stripe merchant/PCI/3DS evidence, the exact
Product/Price/trial/tax match, production billing composition and an authorized
isolated end-to-end billing run, subscription notification/cancellation
settings, limited legal approval of contract formation and the zero-payment
free-trial liability cap, dependency vulnerability disposition, incident
contacts/drill, and provider-backed marketing consent operations. The five
high-severity production dependency findings recorded under Issue #134 remain
unresolved and are not suppressed.

The isolated billing evidence must cover Checkout, signed webhook processing,
trial-to-renewal, payment failure or additional authentication, ordinary
period-end cancellation, and immediate cancellation before account deletion.
It is not permission to create a live Checkout Session, charge, subscription,
email, or production configuration change. The ordinary cancellation evidence
must include the provider-confirmed access end shown to the user; account
deletion must reject a future cancellation schedule.

## Policy archive and display boundary

Before release, archive the exact rendered production versions of the
commercial disclosure, terms, privacy disclosure, processing registry, external
transmission disclosure, checkout copy, and card-security disclosure. Record an
approved-system reference rather than copying confidential review material into
Git.

User-facing full text remains on the existing dedicated legal, checkout, and
account pages. The normal card editor, history, and connections UI receives no
new legal banner, panel, or modal from this gate. The approved service facts are
JPY 980 per month including tax, a 14-day free trial, and automatic first charge
on day 15 unless cancelled.

## Related controls and primary sources

- [Commercial disclosure](./legal-commerce-disclosure.md)
- [Versioned terms](./legal-terms.md)
- [Privacy disclosure](./privacy-disclosure.md)
- [External transmission disclosure](./external-transmission-disclosure.md)
- [Card payment security](./card-payment-security.md)
- [Production operations runbook](./production-operations-runbook.md)
- [Consumer Affairs Agency mail-order guidance](https://www.no-trouble.caa.go.jp/what/mailorder/)
- [Personal Information Protection Commission leak response](https://www.ppc.go.jp/personalinfo/legal/leakAction/)
- [Consumer Affairs Agency advertising email guidance](https://www.caa.go.jp/policies/policy/consumer_transaction/specifed_email/)

Rollback is a PR revert of this manifest, check, tests, and documents. A revert
must leave the production release stopped; it cannot erase legal duties or serve
as production authorization.
