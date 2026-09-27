# Privacy request HTTP and execution boundary

Issue #456 ported the provider-neutral privacy journal and strict Go contract.
Issue #513 connects only its Submit and Status surface in the exact disposable
`local-fixture` composition. The dedicated `/account/privacy` page is the only
browser entry; Notes card, history, and connections views do not mount these
controls. Default and production compositions pass no privacy runtime, so both
routes stay closed.

## Connected HTTP scope

`POST /api/account/privacy-requests` accepts exactly `submissionId` and
`requestKind`. `POST /api/account/privacy-requests/status` accepts exactly
`requestId`. Both derive Account/Vault ownership from the host-only session,
perform authentication and same-origin CSRF checks before reading any body,
and cap the body at `min(NOTES_BODY_LIMIT_BYTES, 2048)`. Duplicate/unknown
members, invalid UTF-8 or UUIDv7 values, trailing JSON, and malformed generated
request IDs fail closed. The local runtime lease is checked immediately before
the PostgreSQL insert or lookup.

Responses are `no-store`, omit owner IDs and private evidence, and strictly
pair request kind with completion outcome. A request outside the authenticated
Vault is indistinguishable from an absent request. Idempotent submission replay
returns the existing journal row; reusing a submission ID for another kind is
a conflict. Browser decoders reject unknown fields, timestamp reversal,
`fulfilled` for deletion, and `account-deletion-started` for non-deletion.

## Runtime matrix

- Default and production: no `PrivacyRequestRuntime`; exact routes remain
  closed.
- Exact local fixture with omitted/`undecided` legal policy: real PostgreSQL
  Submit/Status plus explicit unavailable verification, fulfillment, and
  deletion ports.
- Exact local fixture with `delete-live-evidence`: the same public Submit/Status
  surface. The internal service additionally composes the real fenced
  account-deletion Start handoff for controlled integration evidence only.

The HTTP handler intentionally exposes no Verify, Process, scheduler, provider
callback, or account-deletion Resume operation. A normal browser submission
therefore remains `verification-pending`. The explicit deletion handoff can be
reached only after a controlled test transitions a row to verified/ready and
invokes the internal service. A successful handoff records
`account-deletion-started`, meaning one deletion operation and continuation
were durably admitted; it does not mean any deletion effect ran or data was
deleted.

## Durability, recovery, and retention

The browser form and displayed tracking record are ephemeral and clear on
reload/back-forward restoration. The PostgreSQL journal is separate durable
state: a caller retaining the returned request ID can query it after a Go
process restart while its authenticated owner still exists. Deleting/completed
fixture phases continue to compose the journal service, but the removed/revoked
owner cannot authenticate through normal HTTP.

No processor claims queued work, so the connected browser flow cannot enter
`processing`. Recovery for a future processor response-loss window or a record
left permanently `processing` is not implemented. Post-deletion user access to
status and the production journal retention/purge policy also remain undecided.
These are not reasons to invent success or delete accepted evidence.

Rollback first closes new submissions and processing, then preserves migration
00013 and every journal revision. If a controlled handoff admitted deletion,
also preserve the deletion operation/continuation and serve its reviewed
recovery path. Restore a compatible artifact or apply a forward fix; never
drop a journal row, synthesize verification, or claim fulfillment/deletion.
No production provider, external request, deployment, or paid operation is
authorized by this local connection.
