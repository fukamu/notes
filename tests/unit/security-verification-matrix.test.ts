import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const requirements = [
  {
    id: 'SEC-AUTH-01',
    evidence: ['backend/internal/identity/boundary_test.go'],
  },
  {
    id: 'SEC-AUTH-02',
    evidence: [
      'backend/internal/identity/session_test.go',
      'backend/tests/integration/session_store_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-03',
    evidence: [
      'backend/internal/identity/boundary_test.go',
      'backend/internal/httpapi/sync_v2_test.go',
      'backend/internal/httpapi/legal_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-04',
    evidence: [
      'backend/internal/identity/oidc_test.go',
      'backend/internal/identity/oidc_boundary_test.go',
      'backend/tests/integration/identity_signup_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-05',
    evidence: [
      'backend/internal/identity/oidc_test.go',
      'backend/internal/identity/oidc_boundary_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-06',
    evidence: [
      'backend/internal/identity/email_otp_test.go',
      'backend/internal/identity/email_otp_boundary_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-07',
    evidence: [
      'backend/internal/identity/email_otp_test.go',
      'backend/internal/identity/email_otp_boundary_test.go',
      'backend/internal/adapters/otp/crypto_test.go',
    ],
  },
  {
    id: 'SEC-AUTH-08',
    evidence: ['backend/internal/identity/boundary_test.go'],
  },
  {
    id: 'SEC-AUTH-09',
    evidence: [
      'backend/internal/identity/oidc_boundary_test.go',
      'backend/internal/adapters/otp/crypto_test.go',
    ],
  },
  {
    id: 'SEC-DATA-01',
    evidence: [
      'backend/tests/integration/sync_v2_application_test.go',
      'backend/tests/integration/encrypted_object_test.go',
    ],
  },
  {
    id: 'SEC-DATA-02',
    evidence: [
      'backend/internal/syncv2/protocol_cursor_test.go',
      'backend/internal/httpapi/sync_v2_test.go',
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
      'backend/internal/cryptocontent/model_test.go',
      'backend/tests/integration/encrypted_object_test.go',
    ],
  },
  {
    id: 'SEC-DATA-05',
    evidence: [
      'backend/internal/cryptocontent/service_test.go',
      'backend/tests/integration/encrypted_object_test.go',
    ],
  },
  {
    id: 'SEC-DATA-06',
    evidence: [
      'backend/internal/encryptedobject/delete_outbox_drainer_test.go',
      'backend/tests/integration/encrypted_object_test.go',
    ],
  },
  {
    id: 'SEC-DATA-07',
    evidence: [
      'backend/tests/integration/sync_v2_application_test.go',
      'backend/tests/integration/quota_ledger_test.go',
    ],
  },
  {
    id: 'SEC-DATA-08',
    evidence: ['backend/internal/syncv2/core_test.go'],
  },
  {
    id: 'SEC-DATA-09',
    evidence: ['backend/internal/httpapi/sync_v2_test.go'],
  },
  {
    id: 'SEC-BILLING-01',
    evidence: [
      'backend/internal/stripebilling/signature_test.go',
      'backend/internal/stripebilling/service_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-02',
    evidence: [
      'backend/internal/stripebilling/service_test.go',
      'backend/internal/billing/service_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-03',
    evidence: [
      'backend/internal/billing/core_test.go',
      'backend/internal/stripebilling/core_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-04',
    evidence: [
      'backend/internal/stripebilling/core_test.go',
      'backend/internal/adapters/stripe/provider_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-05',
    evidence: [
      'backend/internal/billing/service_test.go',
      'backend/tests/integration/billing_projection_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-06',
    evidence: [
      'backend/internal/entitlement/service_test.go',
      'backend/tests/integration/entitlement_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-07',
    evidence: ['backend/internal/entitlement/core_test.go'],
  },
  {
    id: 'SEC-BILLING-08',
    evidence: [
      'backend/internal/legal/contract_test.go',
      'backend/tests/integration/contract_evidence_test.go',
    ],
  },
  {
    id: 'SEC-BILLING-09',
    evidence: [
      'backend/internal/legal/terms_service_test.go',
      'backend/internal/legal/contract_test.go',
      'backend/internal/httpapi/legal_test.go',
    ],
  },
  {
    id: 'SEC-LOG-01',
    evidence: [
      'backend/internal/identity/boundary_test.go',
      'backend/internal/httpapi/sync_v2_test.go',
      'backend/internal/httpapi/account_deletion_test.go',
      'backend/internal/stripebilling/service_test.go',
      'backend/internal/httpapi/legal_test.go',
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
