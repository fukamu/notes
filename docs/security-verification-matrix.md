# Security verification matrix

This matrix records deterministic repository evidence for parent Issue #127.
The server evidence is now Go; browser-only behavior remains TypeScript. It is
not a penetration-test report and does not authorize production traffic,
credentials, provider operations, or deployment.

## Identity and authentication

| ID          | Required invariant                                                                            | Automated evidence                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-AUTH-01 | Reject cross-site unsafe requests before session lookup.                                      | `backend/internal/identity/boundary_test.go`                                                                                                          |
| SEC-AUTH-02 | Rotate session ID, token, and epoch; reject stale work.                                       | `backend/internal/identity/session_test.go`, `backend/tests/integration/session_store_test.go`                                                        |
| SEC-AUTH-03 | Derive Account/Vault from the resolved session, never request content.                        | `backend/internal/identity/boundary_test.go`, `backend/internal/httpapi/sync_v2_test.go`, `backend/internal/httpapi/legal_test.go`                    |
| SEC-AUTH-04 | Validate OIDC state, nonce, PKCE, redirect, issuer, audience, time, and one-time consumption. | `backend/internal/identity/oidc_test.go`, `backend/internal/identity/oidc_boundary_test.go`, `backend/tests/integration/identity_signup_test.go`      |
| SEC-AUTH-05 | Key OIDC identity by issuer plus subject; never auto-link by email.                           | `backend/internal/identity/oidc_test.go`, `backend/internal/identity/oidc_boundary_test.go`                                                           |
| SEC-AUTH-06 | Persist only salted OTP digests; expire and consume once.                                     | `backend/internal/identity/email_otp_test.go`, `backend/internal/identity/email_otp_boundary_test.go`                                                 |
| SEC-AUTH-07 | Enforce OTP attempt, resend, send, and rate limits without enumeration.                       | `backend/internal/identity/email_otp_test.go`, `backend/internal/identity/email_otp_boundary_test.go`, `backend/internal/adapters/otp/crypto_test.go` |
| SEC-AUTH-08 | Decode untrusted auth records and fail closed.                                                | `backend/internal/identity/boundary_test.go`                                                                                                          |
| SEC-AUTH-09 | Return generic adapter failures without exposing auth secrets.                                | `backend/internal/identity/oidc_boundary_test.go`, `backend/internal/adapters/otp/crypto_test.go`                                                     |

## Tenant, sync, and cryptography

| ID          | Required invariant                                                           | Automated evidence                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-DATA-01 | Scope content, journal, metadata, and quota by session Vault.                | `backend/tests/integration/sync_v2_application_test.go`, `backend/tests/integration/encrypted_object_test.go`                                       |
| SEC-DATA-02 | Authenticate cursor and receipt scope; reject mismatches and replay.         | `backend/internal/syncv2/protocol_cursor_test.go`, `backend/internal/httpapi/sync_v2_test.go`                                                       |
| SEC-DATA-03 | Commit browser page state only after the complete terminal plan.             | `tests/unit/sync-v2-client.test.ts`, `tests/unit/sync-v2-page-application.test.ts`, `tests/unit/sync-v2-replica.test.ts`, `tests/e2e/notes.spec.ts` |
| SEC-DATA-04 | Bind encrypted data to Vault, object, revision, crypto version, and DEK.     | `backend/internal/cryptocontent/model_test.go`, `backend/tests/integration/encrypted_object_test.go`                                                |
| SEC-DATA-05 | Fail closed on key wrap/unwrap with no plaintext fallback.                   | `backend/internal/cryptocontent/service_test.go`, `backend/tests/integration/encrypted_object_test.go`                                              |
| SEC-DATA-06 | Preserve immutable object intent and retry deletion safely.                  | `backend/internal/encryptedobject/delete_outbox_drainer_test.go`, `backend/tests/integration/encrypted_object_test.go`                              |
| SEC-DATA-07 | Keep journal, quota, and content transitions atomic or explicitly retryable. | `backend/tests/integration/sync_v2_application_test.go`, `backend/tests/integration/quota_ledger_test.go`                                           |
| SEC-DATA-08 | Avoid encryption and object effects for no-change sync.                      | `backend/internal/syncv2/core_test.go`                                                                                                              |
| SEC-DATA-09 | Return generic no-store sync errors without secret-bearing logs.             | `backend/internal/httpapi/sync_v2_test.go`                                                                                                          |

PostgreSQL integration evidence uses only the dedicated local/CI test database.
In-memory and directory adapters remain bounded test evidence; no production
storage or key provider is contacted.

## Billing and cross-module closure

| ID             | Required invariant                                                                      | Automated evidence                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-BILLING-01 | Verify exact raw webhook bytes and reject tamper, time, header, and size failures.      | `backend/internal/stripebilling/signature_test.go`, `backend/internal/stripebilling/service_test.go`                                                                                                                                      |
| SEC-BILLING-02 | Deduplicate provider events and reconciliation checkpoints atomically.                  | `backend/internal/stripebilling/service_test.go`, `backend/internal/billing/service_test.go`                                                                                                                                              |
| SEC-BILLING-03 | Apply provider facts in deterministic evidence order.                                   | `backend/internal/billing/core_test.go`, `backend/internal/stripebilling/core_test.go`                                                                                                                                                    |
| SEC-BILLING-04 | Grant nothing on provider outage or malformed state; retry safely.                      | `backend/internal/stripebilling/core_test.go`, `backend/internal/adapters/stripe/provider_test.go`                                                                                                                                        |
| SEC-BILLING-05 | Resume only from verified or reconciled paid evidence.                                  | `backend/internal/billing/service_test.go`, `backend/tests/integration/billing_projection_test.go`                                                                                                                                        |
| SEC-BILLING-06 | Lock delinquent online/offline access and revoke leases atomically.                     | `backend/internal/entitlement/service_test.go`, `backend/tests/integration/entitlement_test.go`                                                                                                                                           |
| SEC-BILLING-07 | Keep recovery and deletion capabilities available while content is denied.              | `backend/internal/entitlement/core_test.go`                                                                                                                                                                                               |
| SEC-BILLING-08 | Persist immutable owner-scoped contract evidence before provider access.                | `backend/internal/legal/contract_test.go`, `backend/tests/integration/contract_evidence_test.go`                                                                                                                                          |
| SEC-BILLING-09 | Keep terms and commercial idempotency domains independent.                              | `backend/internal/legal/terms_service_test.go`, `backend/internal/legal/contract_test.go`, `backend/internal/httpapi/legal_test.go`                                                                                                       |
| SEC-LOG-01     | Return generic failures and never log plaintext, keys, auth values, or payment details. | `backend/internal/identity/boundary_test.go`, `backend/internal/httpapi/sync_v2_test.go`, `backend/internal/httpapi/account_deletion_test.go`, `backend/internal/stripebilling/service_test.go`, `backend/internal/httpapi/legal_test.go` |

`tests/unit/security-verification-matrix.test.ts` proves each stable ID is
unique, is documented, and references tracked executable evidence. This is a
traceability index, not a claim of exhaustive penetration testing.

## Residual verification boundary

Local adapters cannot prove provider IAM, real network timeout behavior,
production WAF, credential rotation, Stripe delivery, 3-D Secure, backup
retention, restore timing, or production load. These remain V09
approval-pending and require separate production/provider authorization. No
live key, payment, message, storage, webhook, database, or deployment is used
by this evidence.
