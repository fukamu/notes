# Email OTP boundary

Issue #112 defines an abuse-resistant, provider-neutral Email OTP boundary. It
does not select a mail provider, send real email, add an authentication route,
create a database schema, or enable authentication in the local notes
composition.

## Security status and standards limitation

Email OTP remains a confirmed product requirement, but it is not a
phishing-resistant authenticator and must not be represented as NIST AAL
compliant. [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)
does not permit email as an out-of-band authentication channel. The control is
therefore a product-risk acceptance decision, not a claim that the stricter
standard has been met. Google OIDC remains the alternative sign-in method.

This implementation uses an eight-digit code, a ten-minute lifetime, a
five-failure lock, single-use consumption, a 60-second resend interval, and at
most three sends per challenge. A resend rotates the code and salt but does not
reset the failure count or extend the original expiry. These controls reduce
online guessing and abuse; they do not make email phishing-resistant.

Mail delivery provider selection remains **Decision Required**. A real
provider adapter, credential, domain setup, or real email send requires an ADR
and explicit user approval.

## Flow and trust boundaries

The start boundary normalizes a bounded ASCII address, obtains an opaque UUIDv7
challenge ID, eight-digit code, and 256-bit salt from injected ports, and asks a
hashing port for a digest. Only the digest and salt enter the challenge store.
The plaintext code exists only long enough to call `EmailDeliveryPort`; it must
never be persisted or logged. Production hashing must use a server-held pepper
and a construction suitable for the low-entropy code space. The fake adapter
uses SHA-256 only as deterministic test infrastructure and is not a production
password/OTP store.

The store inserts version 1 and implements versioned compare-and-swap. Correct
verification transitions a pending challenge to `consumed`; concurrent replay
has one winner. Incorrect verification increments the persisted attempt count
and locks on the fifth failure. Expired and delivery-failed challenges become
terminal. Malformed storage, hash, clock, and directory values fail closed.

Start and resend deliberately use constant public response shapes. Completion
maps expiry, wrong code, replay, malformed data, identity collision, and
downstream failure to `verification-failed`. This prevents account-existence
reasons from becoming an email enumeration API. Uniform response shape does not
promise constant response latency; production routing should add monitored,
bounded timing controls if testing shows a practical side channel.

## Abuse controls

Start and resend reserve address, network, and, for linking, account limits.
`EmailOtpAbuseKeyPort` receives the already-normalized address and AccountId
derived from `VaultContext`; a production adapter must derive non-reversible
HMAC keys using trusted network metadata. Rate-limit keys must never be accepted
from request JSON or query parameters. The production reservation must update
all applicable dimensions atomically. Cloudflare WAF limits are an additional
layer, not a replacement for this application boundary.

The pure fixed-window policy permits five sends per address, thirty per network,
and five per authenticated account per hour. Operational work may tighten these
values based on observed abuse, but weakening or changing them requires an
explicit reviewed policy change and tests.

## Identity and linking

An Email OTP identity is keyed by its normalized address. Domain comparison is
case-insensitive, while the local part is preserved because provider-specific
dot, plus-tag, Unicode, and mailbox case folding is not portable. This can leave
provider aliases as distinct identities, so a future provider adapter must not
invent alias rules without an explicit identity migration and review.

A verified address already attached to another identity does not silently merge
with a Google account that has the same email attribute. Sign-in fails
generically and linking is a separate challenge purpose. The link target comes
only from the authenticated `VaultContext`, never the request body. An identity
owned by another account and a verified-contact collision are rejected.

Persistence of provision/link decisions and session establishment belongs to
the control-plane composition. That composition must use the #110 session core
and must not grant a session from the start response, delivery success, or an
uncommitted identity plan.

## Local development, migration, and rollback

The current route still mounts `LegacyNotesApp`. Local notes, offline editing,
E2E, and `npm run dev` do not require a mail account, billing configuration, or
an OTP credential. Tests use only fake entropy, challenge storage, abuse limits,
delivery, hashing, and identity-directory adapters; the fake delivery captures
messages in memory and sends nothing externally.

This Issue creates no migration or production state. Reverting it removes only
the Email OTP contracts, fake adapters, tests, and documentation. A real mail
adapter, schema, route, secret, and production rate-limit backend require later
Issues, provider approval, and the production-operation approvals in parent
#106.
