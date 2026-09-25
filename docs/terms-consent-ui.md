# Terms consent presentation

Issue #245 connects the Issue #244 consent status/accept boundary to the
dedicated checkout and account surfaces. The authoritative full document stays
at `/legal/terms`.

## Presentation scope

- `/checkout` shows the current terms version and a link to `/legal/terms`.
  Commercial subscription consent and terms consent are separate, default-off
  checkboxes. Both must be affirmative before submission.
- `/account/terms` shows the current server status. It presents a default-off
  re-consent control only for `current` or `reconsent-required`; `accepted` and
  `notice-only` remain non-blocking status views.
- `/account/billing` has one low-impact text link to `/account/terms`.
- 規約本文、checkbox、常設banner/panel、同意不要modalは通常の Notes UI には追加しない。

The account and checkout pages link to the independent full document instead
of embedding it in the editor. Keyboard labels, focus, desktop/mobile layout,
and back/forward navigation are covered by E2E tests.

## Evidence correlation and retry

The terms-consent and commercial checkout boundaries each create their own
UUIDv7 submission identifier. They represent different legal acts and different
idempotency domains; current UI code does not send one shared identifier. The
server derives Account and Vault from the session for both requests. Go checkout
therefore verifies the latest owner-scoped immutable terms evidence against the
authoritative current version/hash before recording commercial evidence or
calling the payment provider. Calling checkout directly cannot bypass this
gate, and a commercial submission identifier is never treated as terms proof.

Terms acceptance runs before hosted checkout creation. A lost response or a
retry reuses the identifier for that individual operation, so each server
application replays its own prior result. If the terms version/hash changes
before acceptance, the UI reloads the
authoritative terms and offer, clears both checkboxes, and requires a fresh
review. An offer change does the same. Redirect alone remains insufficient for
contract or entitlement state.

## Boundary handling

The HTTP adapter treats JSON as `unknown` and strictly decodes every success
and error response. A success must echo the exact displayed terms version,
hash, and effective date. Requests contain only their operation submission ID,
presented version/hash, and affirmative consent; no tenant identifiers are
accepted. Requests use same-origin credentials and no-store caching.

## Local development and production

`legacy-test` pages use an in-memory adapter. They never contact Stripe, send
mail, alter production evidence, or grant entitlement. The development notice
states this explicitly. Public-paid mode uses the server endpoint and remains
fail closed while its separate production composition is unavailable.

## Migration and rollback

There is no migration. Rollback removes the client/page wiring and stops new
checkout or re-consent UI while preserving all Issue #243 evidence. Production
deployment and changes to `main` require separate approval.
