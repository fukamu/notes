# Terms consent server gate

Issue #244 adds the provider-neutral server application and HTTP boundary for
recording acceptance of the versioned terms published by Issue #242. The
immutable evidence ledger from Issue #243 remains the source of accepted
evidence.

## Presentation boundary

The authoritative terms content remains the dedicated public page at
`/legal/terms`. 通常の Notes UI には表示を追加しない. This Issue does not add a
banner, footer, menu item, modal, or editor interruption. A later registration
or checkout Issue may open the dedicated page or a focused dialog when consent
is actually required, without mounting the terms text in the Notes workspace.

The status response contains only the current version, hash, effective date,
policy status, and accepted evidence identifiers needed by that future flow. It
does not return the full terms document or tenant identifiers.

## Explicit change classification

`CurrentTermsSourcePort` returns decoded current disclosure metadata together
with one explicit legal-review policy:

- `initial-release`: there must be no older accepted evidence;
- `reconsent-required`: a reviewed material change requires a new affirmative
  acceptance;
- `notice-only`: a reviewed non-material change preserves access and may be
  shown by a later notification flow;
- `undecided`: fail closed when an older acceptance exists.

Both change policies carry a `legalReviewId`. Version or hash comparisons never
infer materiality. A same-version or same-hash mismatch is inconsistent
evidence and fails closed.

## HTTP boundary

`GET /api/account/terms-consent` resolves status. It requires an authenticated
session and derives `VaultContext` only from that session. `POST` on the same
path records an affirmative acceptance and additionally requires the existing
same-origin CSRF checks. The JSON body is limited to 2 KiB and decoded as
`unknown`; account and Vault fields are not part of the command contract.

Both methods return `Cache-Control: no-store` and `X-Content-Type-Options:
nosniff`. Clocks and consent identifiers are provided by outer ports. Invalid
source metadata, unavailable hashing or persistence, undecided changes, and
unexpected failures fail closed without logging content, session credentials,
hash input, or tenant identifiers.

## Composition and local development

This Issue deliberately does not choose or wire a production configuration
source. The route is a fail-closed composition stub: `legacy-test` returns 404
so local Notes use is unaffected, while `public-paid` returns 503 until a later
approved production composition provides the source, session resolver,
repository, clock, and identifier generator. Fake ports cover local and test
composition without external providers.

Go Issue #446 provides the equivalent strict HTTP factories behind an optional
`LegalRuntime`. It also changes checkout verification to use the latest current
owner-scoped consent because the real terms and commercial clients generate
independent submission IDs. The production Go command does not supply that
runtime; no terms source is selected and the route remains closed. Browser
decoders are owned by `lib/contracts/terms-consent.ts`, not a server runtime
module.

## Migration and rollback

There is no schema migration in this Issue. Rollback disables the new route and
application composition while leaving the immutable Issue #243 evidence ledger
intact. Existing evidence must not be deleted or rewritten as part of a code
rollback. Production deployment and `main` remain separately authorized work.
