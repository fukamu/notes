# Privacy request HTTP and execution boundary

Issue #236 adds an authenticated, provider-neutral application/HTTP boundary for the journal from #235. It does not change the Notes UI. The later UI is limited to a dedicated account privacy page; normal card, history, and connections views receive no legal banner, panel, or modal.

## HTTP scope and cache boundary

`POST /api/account/privacy-requests` accepts only `submissionId` and `requestKind`. `POST /api/account/privacy-requests/status` accepts only `requestId`. Both use bounded UTF-8 JSON, same-origin CSRF checks, a valid Secure/HttpOnly session, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. `AccountId` and `VaultId` are always derived from the server session; unknown body fields are rejected.

The response exposes the opaque request ID, request kind, public status, and timestamps. It excludes Account/Vault IDs, verification receipt, failure code, email, provider details, and content. A request outside the authenticated Vault returns the same `not-found` result as an absent request.

There is deliberately no entitlement dependency. Payment-locked users must retain access to privacy, account deletion, billing, and support paths.

## Provider-neutral execution

The application never executes work while status is `verification-pending`. A verification port may approve with an opaque UUIDv7 receipt, reject, or remain unavailable. Local/integration tests use explicit fake adapters only.

After verification, non-deletion requests use a generic fulfillment port. Deletion requests cannot use that port: they call `startExistingAccountDeletionSaga`, an explicit handoff to the already implemented deletion workflow. A provider error or thrown effect records a retryable, redacted failure rather than completion. CAS claim replay does not execute a second effect.

The actual identity-verification method, export/correction implementation, provider mapping, answer deadline, fee, and export format remain Decision Required. The checked-in public routes therefore fail closed: legacy-test returns 404 and public-paid/unconfigured modes return 503. Test fakes are never selected by a route.

No provider call, real email, production D1 operation, deployment, or `main` update is part of this Issue.
