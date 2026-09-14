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

Pending #211. It will record cross-Vault equal-identifier isolation, forged
cursor and receipt behavior, malformed page recovery, ciphertext/AAD swap
rejection, D1/R2/KMS failure injection, and no-change sync port-call evidence.

## Billing and cross-module closure — Issue #212

Pending #212. It will record webhook forgery/replay/order, provider outage,
invoice-paid-only recovery, locked capabilities, and the final cross-module
log-redaction/traceability evidence.

## Residual verification boundary

Fake adapters and Miniflare cannot prove provider IAM, network timeout,
production WAF, credential rotation, or provider-specific consistency. Those
remain staging/operations work for #128, #134, and #135 and require the
separate production permissions documented by parent #106.
