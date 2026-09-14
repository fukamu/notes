# Security verification matrix

This matrix records deterministic repository evidence for parent Issue #127.
It is not a penetration-test report and does not authorize production traffic,
credentials, provider operations, or deployment.

## Identity and authentication — Issue #210

| Threat                          | Required invariant                                                                                                     | Automated evidence                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CSRF and cross-site mutation    | Reject before session lookup; accept only exact same-origin metadata for unsafe methods                                | `tests/integration/auth-security-corpus.test.ts`, `tests/unit/session-boundary.test.ts`                                   |
| Session fixation and stale work | Rotate session ID, token, and epoch; revoke the prior session; reject old operation context                            | `tests/integration/auth-security-corpus.test.ts`, `tests/unit/session.test.ts`                                            |
| Forged tenant identity          | Derive Account/Vault only from the resolved session, never request content                                             | `tests/unit/session-boundary.test.ts`, `tests/unit/sync-v2-http-handler.test.ts`                                          |
| OIDC tamper and replay          | Validate state, nonce, PKCE, redirect, issuer, audience, and time; consume one transaction with one race winner        | `tests/integration/auth-security-corpus.test.ts`, `tests/unit/oidc.test.ts`, `tests/unit/oidc-boundary.test.ts`           |
| OIDC identity collision         | Key identity by issuer + subject and never auto-link by email                                                          | `tests/unit/oidc.test.ts`, `tests/unit/oidc-boundary.test.ts`                                                             |
| OTP disclosure and replay       | Persist salted digest only; expire, consume once, and allow one CAS race winner                                        | `tests/unit/email-otp.test.ts`, `tests/unit/email-otp-boundary.test.ts`                                                   |
| OTP abuse and enumeration       | Enforce attempt/resend/send/rate limits while returning the same public start or failure shape                         | `tests/integration/auth-security-corpus.test.ts`, `tests/unit/email-otp.test.ts`, `tests/unit/email-otp-boundary.test.ts` |
| Malformed auth records          | Decode external and persisted values from `unknown`; fail closed without reflecting supplied values                    | `tests/integration/auth-security-corpus.test.ts`                                                                          |
| Secret-bearing adapter failure  | Return typed generic failures without exposing provider errors, OTP codes, OIDC code/verifier/state, or session tokens | `tests/integration/auth-security-corpus.test.ts`                                                                          |

The corpus is deliberately bounded and deterministic. It complements focused
boundary cases; it does not add an unbounded fuzzing or wall-clock gate.

## Tenant, sync, and cryptography — Issue #211

| Threat                           | Required invariant                                                                                                | Automated evidence                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Equal identifiers across Vaults  | Scope create/update/delete/CAS/read, mutation receipts, metadata, and quota by the session Vault                  | `tests/integration/sync-v2-server-d1.test.ts`, `tests/integration/sync-v2-journal-d1.test.ts`, `tests/integration/encrypted-object-repository.test.ts` |
| Forged cursor or receipt         | Authenticate cursor Vault/device/window and reject mismatched, unsent, or replayed receipts without tenant detail | `tests/unit/sync-v2-protocol.test.ts`, `tests/unit/sync-v2-web-crypto.test.ts`, `tests/integration/sync-v2-server-d1.test.ts`                          |
| Malformed or interrupted page    | Do not commit checkpoint, acknowledgements, or page changes until the terminal plan commits                       | `tests/unit/sync-v2-client.test.ts`, `tests/unit/sync-v2-page-application.test.ts`, `tests/unit/sync-v2-replica.test.ts`, `tests/e2e/notes.spec.ts`    |
| Ciphertext/AAD swap              | Bind Vault, object type/id, revision, crypto version, and DEK version; reject tamper and swaps                    | `tests/integration/envelope-encryption.test.ts`, `tests/integration/encrypted-object-repository.test.ts`                                               |
| KMS failure                      | Fail closed on wrap/unwrap for write and read with no plaintext fallback                                          | `tests/integration/envelope-encryption.test.ts`, `tests/integration/encrypted-object-repository.test.ts`                                               |
| R2-compatible object failure     | Preserve immutable intent for retry, reject conflicting bytes, and retry delete outbox                            | `tests/integration/encrypted-object-repository.test.ts`                                                                                                |
| D1 journal/quota/content failure | Roll back atomic metadata or retain an explicit reserved retry state; issue receipt only after commit             | `tests/integration/sync-v2-server-d1.test.ts`, `tests/integration/sync-v2-journal-d1.test.ts`                                                          |
| No-change sync                   | Avoid object-store and encryption/KMS calls when no mutation or content change exists                             | `tests/integration/sync-v2-server-d1.test.ts`                                                                                                          |
| Secret-bearing sync failure      | Log a fixed error category only and return generic no-store error JSON                                            | `tests/unit/sync-v2-http-handler.test.ts`                                                                                                              |

The object-storage and KMS evidence uses private in-memory adapters, while D1
atomicity uses Miniflare. No production storage or key provider is contacted.

## Billing and cross-module closure — Issue #212

Pending #212. It will record webhook forgery/replay/order, provider outage,
invoice-paid-only recovery, locked capabilities, and the final cross-module
log-redaction/traceability evidence.

## Residual verification boundary

Fake adapters and Miniflare cannot prove provider IAM, network timeout,
production WAF, credential rotation, or provider-specific consistency. Those
remain staging/operations work for #128, #134, and #135 and require the
separate production permissions documented by parent #106.
