# Email OTP boundary

Issue #112 defined the historical TypeScript abuse-resistant, provider-neutral
Email OTP boundary. Migration Issue #426 implemented the Go replacement and
persistent identity/signup control plane; T17 removed the TypeScript server
contract and its leftover domain-only types. The Go boundary does not select a
mail provider, send real email, add an authentication route, persist production
challenges or abuse counters, or enable authentication in the local Notes
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
never be persisted or logged. The Go adapter uses framed HMAC-SHA-256 with a
minimum 256-bit server-held pepper and constant-time comparison. Test boundary
fakes remain deterministic infrastructure and are not production OTP stores.

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

Migration 00003 persists a provider-neutral verified-email owner separately
from provider identities. The disconnected Go signup finalizer creates the
account, personal vault, identity, verified-email owner, and hash-only initial
session atomically. It does not grant a session from the start response,
delivery success, or an uncommitted identity plan. Linking persistence remains
a later composition concern.

## Local development, migration, and rollback

The Go static handler mounts the unchanged React notes UI. Local notes, offline
editing, E2E, and `npm run dev` do not require a mail account, billing
configuration, or an OTP credential. Go tests use race-safe in-memory challenge,
abuse-limit, and delivery adapters; fake delivery captures messages in memory
and sends nothing externally. The shared fixture is executed by Go identity
tests; no TypeScript OTP server contract remains.

Issue #426 adds migration 00003 only to disposable local/test PostgreSQL. Its
Go identity directory and signup finalizer are implemented but disconnected.
Before production use, the system still needs reviewed persistent challenge and
rate-limit adapters, trusted network extraction, secret configuration and
rotation, a mail adapter/provider, route/UI composition, monitoring, and the
T10 terms adapter. Reverting before a production migration is a reviewed code
revert plus test-schema recreation. After persistent identity or evidence rows
exist, rollback must disable signup and use a forward migration; it must not
drop verified-email ownership or immutable terms evidence.
