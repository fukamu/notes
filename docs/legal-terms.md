# Versioned legal terms and production build gate

Issue #242 adds the canonical terms URL at `/legal/terms`. It uses the public
layout and does not mount the Notes application. The normal card editor, history,
and connections views receive no terms body, checkbox, banner, panel, or dialog.
The public header/footer provides a restrained text link; later clickwrap belongs
only to signup, checkout, and account terms flows.

## Local and test mode

With no `FUKAMU_SERVICE_MODE`, or with `legacy-test`, the page renders a built-in
sample. It is explicitly labelled as development-only and deliberately leaves
the legally undecided liability, service-end notice, and venue wording as sample
text. It creates no account, consent evidence, payment, provider call, or
production operation. Operator samples come from the same replaceable fixture
as the local commercial and privacy pages.

## Production configuration

`public-paid` requires `FUKAMU_LEGAL_TERMS_JSON`. The strict decoder rejects
unknown/missing fields and drift from fixed product behavior: FUKAMU Notes is
paid-only; authentication is Google Login and Email OTP without passwords or a
shared Vault; one Account has one Personal Vault; trial is 14 days and the first
charge is day 15; payment failure locks online use and only `invoice.paid`
restores it; subscription cancellation is separate from account deletion;
logout removes local content, account deletion removes live data, and backup
residue is at most 30 days. User content ownership remains with the user and its
license scope is fixed to the minimum needed to provide the service.

Eligibility is expressed by legal capacity to conclude the paid recurring
contract without a legal representative's consent. The public page does not use
an age-category label and signup does not collect date of birth. Production
configuration must reproduce this approved eligibility sentence exactly, which
prevents a configuration change from silently introducing a different age or
guardian rule.

The production validator also rejects sample/placeholder wording, an unverified
corporate name, and non-production support URLs. This is a completeness gate,
not legal approval. Liability limits, service-end notice, governing law/venue,
remaining final Japanese wording, and material-change handling remain Decision
Required and require qualified Japanese legal review before production launch.

`npm run build` executes `check:legal-terms`. That check resolves the commercial,
privacy, and terms sources together and fails when operator identity, support
URL, trial, cancellation/refund, or retention behavior disagrees across them.

## Boundaries and rollback

Decoding, production validation, and consistency checks are typed pure functions.
Only the environment adapter reads `process.env`; the page receives a decoded
disclosure. There is no schema migration or provider integration in #242.
Rollback is one PR revert. A version already presented or accepted must later be
retained by the immutable consent/version history rather than silently replaced.
