# Signup terms admission

Issue #246 historically connected the TypeScript provider-neutral Google OIDC
and Email OTP verification boundaries to one terms admission application.
Migration Issue #426 implemented the current Go admission core and PostgreSQL
provisioning adapter, and T17 removed the TypeScript server implementation and
tests. The Go boundary does not add a real Google client, mail provider, public
authentication route, production terms source, or deployment.

## Flow and trust boundary

The signup page presents a default-off consent control and links to the
canonical, independently addressable `/legal/terms` page. The accepted terms
command is decoded when Google OIDC starts or an Email OTP challenge is
created, then stored in the server-side OIDC transaction or hashed-OTP
challenge. The callback and OTP completion therefore do not trust a newly
supplied account, Vault, version, or consent value.

After provider verification, an existing identity continues through the
existing authentication/linking result. A `provision-account` result is never
returned directly. It requires the shared `SignupAdmissionPort`; missing terms
or a missing port fails closed through the provider's existing generic error.

The admission application reserves server-generated AccountId, VaultId,
IdentityId, initial SessionId, and epoch 1 idempotently by the terms submission
ID. It records the current immutable terms snapshot under that reserved
Account/Vault scope, then and only then calls the atomic provisioning finalizer.
The reservation, evidence, identity, and receipt must all agree. A retry with
the same identity and submission reuses the same identifiers, so it cannot
create a second Account, Vault, identity, or session. Go cannot recover a raw
bearer token from its stored hash: each successful retry therefore returns a
fresh token and atomically replaces the hash for that same active session.

The terms application accepts a narrow internal Account/Vault scope so a
server-owned provisional reservation can record evidence before the first
session is issued. Public account terms HTTP handling still derives its scope
from the authenticated session and CSRF-protected request; clients cannot send
AccountId or VaultId. A production provisioning adapter must reserve and
finalize atomically and must clean abandoned reservations without deleting
immutable evidence prematurely.

## UI isolation and local development

Affirmative consent belongs only to the dedicated signup flow. The full text
remains on `/legal/terms` and may be opened by a restrained link or accessible
dialog. Legal text, checkboxes, permanent banners/panels, and unnecessary
modals are not added to the normal Notes UI. This Issue adds no React view at
all, so existing card editing, history, connections, keyboard, IME, offline,
and local-first behavior are unchanged.

通常の Notes UI には追加しない、という表示方針をこの後の実provider UIにも
引き継ぎます。

Local Notes composition remains provider-free. Current Go tests use injected
deterministic identifiers, an in-memory terms adapter, disposable PostgreSQL,
and fake Email OTP delivery. The PostgreSQL finalizer receives only a token
hash. No Stripe, Google, email, D1, or production operation is performed.

## Migration and rollback

Migration 00003 adds idempotent reservations and canonical verified-email
ownership. Finalization inserts the account, personal vault, provider identity,
email owner, and initial session in one serializable transaction; constraint
conflicts roll the whole transaction back. Reverting before a production apply
removes the disconnected code and recreates only the disposable test schema.
After evidence or finalized accounts exist, rollback must retain them and use a
reviewed forward migration. During rollback or an admission outage, new signup
must remain disabled rather than bypassing the gate. Real provider UI/adapters
and deployment require their own reviewed Issues and explicit
provider/secret/deployment approval. T10a Issue #442 now supplies the
disconnected Go terms adapter and PostgreSQL evidence store. It authorizes the
pre-finalization write only through the exact durable reservation and remains
unavailable from HTTP or a production legal-terms source.
