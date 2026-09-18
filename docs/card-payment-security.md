# Card payment security boundary

Issue #134 fixes the application-side card data boundary and records which
production evidence is still missing. It does not claim PCI DSS compliance,
select a Self-Assessment Questionnaire, create a Stripe account, use a real
card, or change a production Stripe setting.

## Data flow and non-retention

FUKAMU Notes uses only Stripe-hosted Checkout for payment-method registration.
The user deliberately leaves the application for `https://checkout.stripe.com`
and enters cardholder data there. The browser and server application do not
render a card-number field and do not accept PAN, CVC/CVV, or expiry fields in
their billing contracts.

The application sends opaque contract, subscription, and checkout identifiers
to the Stripe API boundary. It receives an opaque Checkout reference and a
strictly validated hosted URL. Later billing state changes come from a
raw-body, signature-verified webhook or an explicitly reconciled Stripe
snapshot. The application stores those opaque identifiers and verified billing
facts, not cardholder data.

```text
FUKAMU checkout review
  -> Stripe-hosted Checkout (cardholder data stays with Stripe)
  -> signed Stripe webhook / reconciled snapshot
  -> decoded billing fact
  -> entitlement state
```

The source/build gate checks the relevant billing and Stripe contracts for
cardholder-data field names. This is evidence of the intended source boundary,
not a substitute for browser/network inspection of the final production
configuration or for Stripe/acquirer PCI guidance.

## EMV 3-D Secure and recurring charges

Checkout session creation fixes all of the following in the pure Stripe plan:

- `mode=subscription`;
- `payment_method_collection=always`;
- a 14-day trial;
- `payment_method_options[card][request_three_d_secure]=any`; and
- cancellation if the trial somehow ends without a payment method.

The reconciled trial is accepted only after a succeeded SetupIntent whose
`usage` is `off_session`. A later `invoice.payment_action_required` event locks
online use immediately. A successful SetupIntent/card update does not unlock
the account; only a verified, newer `invoice.paid` fact can resume online use.
Redirect completion is never an entitlement fact.

Stripe documents that Japanese online businesses must account for the EMV 3-D
Secure requirements, that a saved card for merchant-initiated recurring
transactions should use an off-session SetupIntent, and that 3DS may still be
needed based on risk and transaction circumstances. Therefore production must
record real test-mode evidence for challenge success, challenge failure,
action-required locking, the first post-trial invoice, and a recurring invoice.
The repository fixture tests do not replace that evidence.

## User-facing disclosure

The dedicated `/checkout` page explains that:

- card numbers and security codes are entered on Stripe's screen and are not
  obtained or stored by the FUKAMU Notes server; and
- the card issuer may require 3-D Secure authentication.

It links to `/legal/external-transmission` for processor and transmission
details. Nothing is added to the normal Notes editing, history, or connections
surfaces.

## Production evidence still required

`cardPaymentSecurityManifest` deliberately evaluates to `blocked`. The launch
owner must replace that state only with dated, reviewable evidence for all of
the following:

1. Stripe contract/merchant review confirming the operating company is the
   merchant and Stripe is the PSP/payment processor.
2. Stripe or acquirer confirmation of the applicable PCI DSS and SAQ scope for
   the final hosted-Checkout configuration.
3. Stripe test-mode results for 3DS challenge, failure, post-trial charge, and
   recurring charge behavior using the final production-like configuration.
4. Dependency and application vulnerability review, remediation ownership,
   and an agreed review cadence. `npm audit --omit=dev` may inform this review
   but is not by itself a complete application-security assessment.
5. A real incident contact and a completed card-incident escalation drill.

No placeholder, fixture result, code review, or passing unit test is accepted
as provider/acquirer confirmation.

### Dependency audit result

On 2026-09-15, `npm audit --omit=dev --audit-level=high` exited with status 1
and reported five high-severity findings involving `image-size` through
`vinext`, `react-server-dom-webpack`, `undici`, and `vite`. The suggested full
remediation changes framework/runtime versions outside their current declared
ranges, so this Issue does not apply an unreviewed forced upgrade. These results
are unresolved production-launch blockers and require applicability triage,
safe version selection, regression verification, and recorded ownership before
the launch checklist may pass.

## EC merchant controls

The March 2025 Credit Card Security Guidelines 6.0 material identifies website
vulnerability measures, EMV 3-D Secure, and appropriate unauthorized-login
measures as EC merchant controls. FUKAMU Notes uses Google OIDC or one-time
Email OTP rather than passwords; OTP expiry, single use, attempt limits, resend
intervals, and application rate limits are implemented elsewhere in #106.
Those controls and the existing security/load corpus remain required. The
production launch review must additionally record vulnerability results and
operational ownership rather than inferring readiness from CI alone.

## Rollback and environment boundary

This Issue has no database migration and makes no production provider call.
Rollback is a revert of its source changes or disabling Checkout while keeping
billing locked. Local fixtures never contact Stripe and never create a
contract, card registration, charge, or entitlement.

## Primary sources reviewed on 2026-09-15

- METI, Credit Card Security Guidelines 6.0 revision announcement:
  https://www.meti.go.jp/press/2024/03/20250305002/20250305002.html
- Stripe, Japan 3DS mandate exemptions:
  https://docs.stripe.com/payments/3d-secure/japan-exemptions
- Stripe, Setup Intents API:
  https://docs.stripe.com/payments/setup-intents
- Stripe, authenticate with 3D Secure:
  https://docs.stripe.com/payments/3d-secure/authentication-flow
- Stripe, build subscriptions with hosted Checkout:
  https://docs.stripe.com/payments/checkout/build-subscriptions
- Stripe, test Billing and 3DS behavior:
  https://docs.stripe.com/billing/testing

These engineering sources do not replace advice from Stripe/the acquirer or a
qualified Japanese legal and compliance professional for the final business
and production configuration.
