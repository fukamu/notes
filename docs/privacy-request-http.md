# Privacy request HTTP and execution boundary

Issue #236 added the TypeScript reference application/HTTP boundary. Migration
Issue #456 ports that contract to `backend/internal/privacyrequest` and
`backend/internal/httpapi/privacy_request.go`. It does not change the Notes UI.
The existing UI remains limited to the dedicated account privacy page; normal
card, history, and connections views receive no legal banner, panel, or modal.

## HTTP scope and cache boundary

`POST /api/account/privacy-requests` accepts only `submissionId` and
`requestKind`. `POST /api/account/privacy-requests/status` accepts only
`requestId`. Both use bounded strict UTF-8 JSON, reject duplicate, unknown, and
trailing input, perform session/owner/CSRF resolution before reading the body,
and return `Cache-Control: no-store` plus
`X-Content-Type-Options: nosniff`. `AccountId` and `VaultId` are always derived
from the server session.

The response exposes the opaque request ID, request kind, public status, and
timestamps. It excludes Account/Vault IDs, verification receipt, failure code,
email, provider details, and content. A request outside the authenticated Vault
returns the same `not-found` result as an absent request.

There is deliberately no entitlement dependency. Payment-locked users must
retain access to privacy, account deletion, billing, and support paths.

## Provider-neutral execution

The application never executes work while status is `verification-pending`. A
verification port may approve with an opaque UUIDv7 receipt, reject, or remain
unavailable. Local and integration tests use explicit fakes only.

After verification, non-deletion requests use a generic fulfillment port.
Deletion requests cannot use that port: they call
`StartExistingAccountDeletion`, an explicit handoff to the existing deletion
workflow. A provider error records a retryable, redacted failure rather than
completion. The PostgreSQL compare-and-swap claim ensures concurrent/replayed
processing does not execute a second effect.

The actual identity-verification method, export/correction implementation,
provider mapping, answer deadline, fee, export format, and recovery of a
permanently `processing` request remain Decision Required. The Go constructor
is intentionally absent from `HandlerOptions`; the checked-in public routes
therefore keep their existing closed 404/503 behavior. Test fakes are never
selected by a route.

No provider call, real email, production database operation, deployment,
fulfillment claim, public route, or `main` update is part of Issue #456.
