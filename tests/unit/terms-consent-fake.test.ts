import { describe, expect, it } from 'vitest';
import { createFakeTermsConsentRepository } from '@/server/terms-consent/fake';
import { billingContext } from '@/tests/fixtures/billing';
import {
  termsConsentIds,
  termsConsentRecord,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

describe('fake terms consent repository', () => {
  it('models scoped replay, identifier conflict, and latest evidence', async () => {
    const repository = createFakeTermsConsentRepository();
    const first = termsConsentRecord();
    const second = termsConsentRecord({
      consentId: termsConsentIds.consentB,
      submissionId: termsConsentIds.submissionB,
      snapshot: termsSnapshot('b'),
      acceptedAt: 3_000,
    });
    await expect(repository.append(billingContext(), first)).resolves.toEqual({
      kind: 'created',
    });
    await expect(repository.append(billingContext(), first)).resolves.toEqual({
      kind: 'existing',
      record: first,
    });
    await expect(
      repository.append(
        billingContext(),
        termsConsentRecord({
          submissionId: termsConsentIds.submissionC,
        }),
      ),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(repository.append(billingContext(), second)).resolves.toEqual({
      kind: 'created',
    });
    await expect(
      repository.append(billingContext('b'), second),
    ).resolves.toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    await expect(repository.findLatest(billingContext())).resolves.toBe(second);
    await expect(
      repository.findBySubmission(
        billingContext('b'),
        termsConsentIds.submissionA,
      ),
    ).resolves.toBeUndefined();
  });
});
