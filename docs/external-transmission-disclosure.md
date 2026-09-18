# External transmission disclosure and destination inventory

Issue #133 records the browser-facing external destinations used by FUKAMU
Notes and publishes the corresponding Japanese disclosure at
`/legal/external-transmission`. It does not add an analytics, advertising,
error-monitoring or consent SDK, contact a provider, or determine a legal
question automatically.

## Current browser boundary

The application currently declares exactly two third-party browser origins:

| Destination     | Origin                        | Trigger                                                       | Product purpose                                              |
| --------------- | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Google Login    | `https://accounts.google.com` | The user chooses Google Login                                 | OIDC authentication with state, nonce and PKCE               |
| Stripe Checkout | `https://checkout.stripe.com` | The user confirms the subscription terms and chooses Checkout | Hosted payment-method registration and subscription checkout |

Normal card editing, history and connections use the first-party origin. The
repository contains no browser analytics, advertising or error-monitoring tag.
The required `__Host-fukamu_session` cookie is sent only to the first-party
origin. IndexedDB and Cache Storage support local-first/offline behavior, and
the existing logout purge removes the signed-out user's local content.
The provider-neutral server telemetry contract has no production sink. GCP
Cloud KMS is a server-to-server encryption dependency and is not a browser
destination. Email delivery will likewise be a server-side provider boundary
after a provider is selected.

The manifest lists the information, recipient legal entities, FUKAMU Notes
purpose, recipient purpose, privacy URL and the effect of not using each
destination. The destination policy is also called by the OIDC redirect
serializer and the Checkout URL decoder. An undeclared origin therefore fails
closed instead of becoming a browser link.

The runtime Content Security Policy restricts subresource and API connections
to the first-party origin (`connect-src 'self'`) and disallows objects and
third-party framing. Google and Stripe are top-level, user-initiated
navigations, not embedded scripts or cross-origin fetches. Adding a tag, frame,
image or API destination therefore requires an explicit CSP and manifest
change reviewed in the same PR.

## UI and consent decision

The canonical disclosure is a directly addressable public page linked from the
privacy policy and the public footer. It does not add a banner, panel or modal
to the Notes interface. Both current transmissions follow an explicit user
choice and are required only for the selected Google Login or paid Checkout
flow. Email OTP remains available instead of Google Login. Subscription signup
cannot complete without a payment method, so declining Stripe prevents the paid
contract rather than silently starting an optional transmission.

Because no optional tracking exists, this change does not add a cookie consent
dialog. If an optional tag or SDK is proposed later, its recipient, data and
purposes must be added to the manifest and the need for prior consent or an
opt-out must be reviewed before the code can load it.

## Telecommunications-law assessment

The engineering assessment is deliberately narrower than a legal opinion:

- FUKAMU Notes stores one user's private Personal Vault and provides no sharing,
  messaging, public posting, marketplace, general web search or public
  information-distribution function.
- On the current facts, it does not appear to match the four covered-service
  categories in Telecommunications Business Act Enforcement Regulations
  Article 22-2-27 that the Ministry's external-transmission FAQ describes.
- The service does use telecommunications to provide paid SaaS/storage. Whether
  it is a registration-exempt third-category business, and whether the specific
  production service is subject to Article 27-12, remains a case-specific legal
  determination.
- The disclosure is published voluntarily even if the rule is ultimately found
  not to apply. A qualified Japanese lawyer or the competent Regional Bureau of
  Telecommunications must confirm applicability before production launch. A
  future sharing, public publishing, messaging, search, advertising or
  analytics feature requires re-assessment.

Primary sources reviewed on 2026-09-15:

- Ministry of Internal Affairs and Communications, external-transmission FAQ:
  https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00002.html
- Ministry pamphlet, _External transmission rules_:
  https://www.soumu.go.jp/main_content/000862755.pdf
- Telecommunications Business Act:
  https://laws.e-gov.go.jp/law/359AC0000000086
- Google OIDC reference:
  https://developers.google.com/identity/openid-connect/reference
- Google privacy policy:
  https://policies.google.com/privacy?hl=ja
- Stripe Services Agreement (Japan contracting entities):
  https://stripe.com/legal/ssa
- Stripe privacy policy and privacy center:
  https://stripe.com/jp/privacy
  https://stripe.com/en-jp/legal/privacy-center

The Ministry opened a public consultation in August 2026 on a draft second
report about compliance with the external-transmission rules. It is not treated
as enacted law here; the launch review must check the final result and current
FAQ again.

## Verification, change control and rollback

`npm run build` decodes the checked-in manifest. Unit and architecture tests
verify exact membership, reject malformed or unknown destinations, require the
OIDC and Checkout adapters to use the shared policy, and ensure the Notes UI
does not acquire legal disclosure or consent UI. Browser tests verify the
dedicated page, privacy/footer links and the absence of a Notes dialog.

There is no schema or data migration. Rollback is the PR revert. If the browser
destination policy and provider integration ever disagree, disable the affected
Google Login or Checkout flow until both code and disclosure are reviewed;
never broaden the origin allowlist as a fallback.
