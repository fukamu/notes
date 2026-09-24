# Google OIDC boundary

Issue #111 defines the TypeScript provider-neutral Google sign-in boundary.
Migration Issue #424 implements its Go replacement without creating a Google
Cloud client, adding a repository secret, calling Google, adding a login route,
or enabling authentication in the local notes composition.

## Flow and trust boundaries

The start boundary decodes provider configuration and an exact allowlisted
redirect URI, obtains independent state, nonce, and PKCE verifier values from
an injected entropy port, derives an S256 challenge, and atomically inserts a
ten-minute pending transaction. Only the challenge enters the authorization
request; the verifier remains in the server-side transaction.

The callback decoder accepts exactly one authorization code or provider error.
The transaction store must atomically return and consume the state, so provider
denial, malformed claims, token-exchange failure, and successful login all make
the callback single-use. The boundary consumes before code exchange and maps
every public failure to the same `authentication-failed` result.

The token port is a deliberately narrow seam. The Go adapter uses pinned
`coreos/go-oidc/v3/oidc` and `golang.org/x/oauth2` to exchange the code over
TLS, send the stored verifier and exact redirect URI, and verify ID-token
signature, advertised algorithm, JWKS, exact discovery issuer, audience, and
expiry. The application boundary then decodes the returned claims into bounded
types and independently checks the configured issuer allowlist, audience,
`azp` for multiple audiences, expiry, issued-at bounds, nonce, subject, and
verified email.
Google documents both `https://accounts.google.com` and its legacy exact
`accounts.google.com` issuer value; the issuer codec can represent both, but a
deployment accepts only values explicitly present in its configured allowlist.

These rules follow [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-18.html),
[Google's OpenID Connect guidance](https://developers.google.com/identity/openid-connect/openid-connect),
[RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html), and the exact
redirect recommendations in [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

## Identity and linking

Google identity is keyed only by the exact `(issuer, subject)` pair. Email is a
verified attribute used to detect collisions, never an identity key. A sign-in
whose issuer/subject is unknown but whose email already belongs to an account
fails generically; it is not silently merged.

Account linking is a separate transaction purpose. The target AccountId is
derived from the authenticated `VaultContext` at the start boundary and cannot
be supplied in the request body. A new identity can link only to that account;
an identity or verified email owned by another account is rejected. Persistence
of the resulting provision/link plan belongs to the control-plane schema work.
The current `identities` schema stores provider, issuer, and subject but no
verified email, and the TypeScript email lookup has only a fake adapter. The Go
boundary therefore keeps this lookup as a fail-closed port. The OTP/signup slice
must add a verified-email persistence and uniqueness contract before any route
can be published; issuer or subject is never treated as a substitute for email.

After the identity/control-plane operation commits, `establishOidcSession`
creates a fresh initial session or rotates a same-account/same-vault session via
the #110 session core. It rejects account switching until explicit logout and
never reuses the previous session ID, bearer token, or epoch.

## Local development, migration, and rollback

The current static route continues to mount the legacy notes UI; local notes,
offline editing, and E2E do not require Google or billing configuration. Go
boundary tests use fake entropy, atomic in-memory transaction, provider, and
identity-directory adapters. Adapter tests use an ephemeral local TLS discovery,
token, and JWKS server and verify the RFC 7636 S256 vector. No real provider
request or email is sent.

This Issue creates no schema or data migration. Reverting #424 removes only the
disconnected Go OIDC core/provider adapter, tests, documentation, and pinned Go
dependencies. A real Google client/secret, callback route, callback-browser
binding, and production transaction/identity stores require later Issues and
explicit secret/provider approval. The Strict session cookie is not weakened:
because it will not accompany a cross-site Google callback, a separate
short-lived callback binding remains required before publication.
