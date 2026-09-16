import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const requirements = [
  {
    id: 'SEC-AUTH-01',
    evidence: [
      'tests/integration/auth-security-corpus.test.ts',
      'tests/unit/session-boundary.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-02',
    evidence: [
      'tests/integration/auth-security-corpus.test.ts',
      'tests/unit/session.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-03',
    evidence: [
      'tests/unit/session-boundary.test.ts',
      'tests/unit/sync-v2-http-handler.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-04',
    evidence: [
      'tests/integration/auth-security-corpus.test.ts',
      'tests/unit/oidc.test.ts',
      'tests/unit/oidc-boundary.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-05',
    evidence: ['tests/unit/oidc.test.ts', 'tests/unit/oidc-boundary.test.ts'],
  },
  {
    id: 'SEC-AUTH-06',
    evidence: [
      'tests/unit/email-otp.test.ts',
      'tests/unit/email-otp-boundary.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-07',
    evidence: [
      'tests/integration/auth-security-corpus.test.ts',
      'tests/unit/email-otp.test.ts',
      'tests/unit/email-otp-boundary.test.ts',
    ],
  },
  {
    id: 'SEC-AUTH-08',
    evidence: ['tests/integration/auth-security-corpus.test.ts'],
  },
  {
    id: 'SEC-AUTH-09',
    evidence: ['tests/integration/auth-security-corpus.test.ts'],
  },
  {
    id: 'SEC-DATA-01',
    evidence: [
      'tests/integration/sync-v2-server-d1.test.ts',
      'tests/integration/sync-v2-journal-d1.test.ts',
      'tests/integration/encrypted-object-repository.test.ts',
    ],
  },
  {
    id: 'SEC-DATA-02',
    evidence: [
      'tests/unit/sync-v2-protocol.test.ts',
      'tests/unit/sync-v2-web-crypto.test.ts',
      'tests/integration/sync-v2-server-d1.test.ts',
    ],
  },
  {
    id: 'SEC-DATA-03',
    evidence: [
      'tests/unit/sync-v2-client.test.ts',
      'tests/unit/sync-v2-page-application.test.ts',
      'tests/unit/sync-v2-replica.test.ts',
      'tests/e2e/notes.spec.ts',
    ],
  },
  {
    id: 'SEC-DATA-04',
    evidence: [
      'tests/integration/envelope-encryption.test.ts',
      'tests/integration/encrypted-object-repository.test.ts',
    ],
  },
  {
    id: 'SEC-DATA-05',
    evidence: [
      'tests/integration/envelope-encryption.test.ts',
      'tests/integration/encrypted-object-repository.test.ts',
    ],
  },
  {
    id: 'SEC-DATA-06',
    evidence: ['tests/integration/encrypted-object-repository.test.ts'],
  },
  {
    id: 'SEC-DATA-07',
    evidence: [
      'tests/integration/sync-v2-server-d1.test.ts',
      'tests/integration/sync-v2-journal-d1.test.ts',
    ],
  },
  {
    id: 'SEC-DATA-08',
    evidence: ['tests/integration/sync-v2-server-d1.test.ts'],
  },
  {
    id: 'SEC-DATA-09',
    evidence: ['tests/unit/sync-v2-http-handler.test.ts'],
  },
  {
    id: 'SEC-BILLING-01',
    evidence: [
      'tests/unit/stripe-webhook-signature.test.ts',
      'tests/unit/stripe-service.test.ts',
    ],
  },
  {
    id: 'SEC-BILLING-02',
    evidence: [
      'tests/unit/stripe-service.test.ts',
      'tests/unit/billing-service.test.ts',
    ],
  },
  {
    id: 'SEC-BILLING-03',
    evidence: [
      'tests/unit/billing-core.test.ts',
      'tests/unit/stripe-service.test.ts',
    ],
  },
  {
    id: 'SEC-BILLING-04',
    evidence: ['tests/unit/stripe-service.test.ts'],
  },
  {
    id: 'SEC-BILLING-05',
    evidence: [
      'tests/integration/stripe-billing-entitlement.test.ts',
      'tests/unit/billing-service.test.ts',
    ],
  },
  {
    id: 'SEC-BILLING-06',
    evidence: [
      'tests/integration/stripe-billing-entitlement.test.ts',
      'tests/unit/entitlement-service.test.ts',
      'tests/integration/entitlement-d1.test.ts',
    ],
  },
  {
    id: 'SEC-BILLING-07',
    evidence: ['tests/unit/entitlement-core.test.ts'],
  },
  {
    id: 'SEC-LOG-01',
    evidence: [
      'tests/integration/auth-security-corpus.test.ts',
      'tests/unit/sync-v2-http-handler.test.ts',
      'tests/integration/sync-api-d1.test.ts',
      'tests/unit/account-deletion-http-handler.test.ts',
      'tests/unit/stripe-service.test.ts',
    ],
  },
] as const;

describe('security verification matrix traceability', () => {
  it('maps every required threat ID to existing automated evidence', async () => {
    const matrix = await readFile(
      'docs/security-verification-matrix.md',
      'utf8',
    );
    expect(new Set(requirements.map(({ id }) => id)).size).toBe(
      requirements.length,
    );
    expect(matrix).not.toContain('Pending #212');

    for (const requirement of requirements) {
      expect(matrix, requirement.id).toMatch(
        new RegExp(`\\|\\s*${requirement.id}\\s*\\|`),
      );
      for (const evidence of requirement.evidence) {
        await expect(
          access(evidence),
          `${requirement.id}: ${evidence}`,
        ).resolves.toBeUndefined();
        expect(matrix, `${requirement.id}: ${evidence}`).toContain(
          `\`${evidence}\``,
        );
      }
    }
  });
});
