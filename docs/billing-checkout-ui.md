# Dedicated checkout and account billing UI

Issue #225 keeps subscription review and cancellation outside the Notes editing
surface. The canonical entry points are `/checkout` and `/account/billing`.
Neither route is mounted by the Notes route group, and card, history, and
connections screens do not receive legal copy, billing banners, or blocking
dialogs.

## Checkout review

The checkout page presents the current service and plan, the 14-day zero-yen
period, relative day-15 first charge, tax-inclusive recurring charge, annual
estimate, renewal, payment method, service start and period, cancellation,
refund, additional fees, payment-failure lock, and the difference between
cancellation and account deletion. The commercial-transactions disclosure
remains a separate canonical page linked from this review.

Consent starts unchecked. The client sends only the server-decodable submission
ID, presented offer hash, and affirmative consent. Account, Vault, price, date,
and provider values are never supplied by client state. A double click is
fenced in the client, and a retry reuses the same submission ID. When the server
reports a stale offer, the page reloads the authoritative offer, clears consent,
and asks for a new review.

A successful command displays the recorded offer again before offering the
trusted Stripe-hosted URL. It does not call a redirect, card update, or browser
return proof of an active entitlement. Provider webhooks and verified
`invoice.paid` facts remain authoritative.

## Cancellation

`/account/billing` exposes cancellation through an accessible confirmation
dialog. Closing the dialog returns focus to its trigger. Retryable provider
failures remain visible and reuse one idempotency key. The UI only displays a
real completion after the server cancellation port returns `confirmed`; a 409,
malformed response, or dependency failure never becomes a success. The endpoint
has no Notes entitlement gate, so it remains reachable during a payment lock.

## Local and production composition

In the existing `legacy-test` mode, both pages carry an unmistakable development
fixture notice. The checked-in billing routes still return 404 and do not
compose D1, Stripe, or a fake provider. The UI treats that exact local-only
response as a harmless in-browser sample confirmation, so local Notes work can
exercise the screens without credentials, network calls, contracts, or charges.

In `public-paid` mode, there is no local fallback. The browser must obtain the
offer and confirmation from the authenticated, CSRF-protected billing APIs. The
current production route stubs therefore fail closed with 503 until a separately
approved composition supplies real infrastructure. No production provider,
secret, webhook, deployment, or charge is introduced by #225.

## Verification and remaining launch evidence

Unit tests cover UI state transitions and unknown-response decoding. Browser
tests cover field-level content, initial consent, double click, stale-offer
reload, stable retries, confirmation re-review, normal history navigation,
mobile rendering, cancellation dialog focus, and separation from Notes.
`/checkout` and `/account/billing` remain network-only under the existing
Service Worker allowlist.

The exact calendar first-charge date is intentionally not fabricated before
Stripe creates the subscription. The approved test-mode provider screen must
show that date and the final subscription action. Capturing that rendered
evidence and obtaining qualified Japanese legal review remain launch-gate work;
they require the separate Stripe/test-provider approval already recorded in
#130 and #135.
