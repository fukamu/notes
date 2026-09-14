import type { TermsConsentApplication } from './application';
import { termsConsentRecordMatchesContext } from './core';
import {
  termsConsentSubmissionIdDecoder,
  type TermsConsentCheckoutVerification,
  type TermsConsentCheckoutVerifierPort,
  type TermsConsentRepository,
} from './public';

export function createTermsConsentCheckoutVerifier(dependencies: {
  readonly application: Pick<TermsConsentApplication, 'status'>;
  readonly repository: TermsConsentRepository;
}): TermsConsentCheckoutVerifierPort {
  return {
    async verify(input): Promise<TermsConsentCheckoutVerification> {
      const submissionId = termsConsentSubmissionIdDecoder.decode(
        input.submissionId,
      );
      if (!submissionId.ok) {
        return { kind: 'rejected', reason: 'terms-consent-required' };
      }
      let status;
      let record;
      try {
        [status, record] = await Promise.all([
          dependencies.application.status({ context: input.context }),
          dependencies.repository.findBySubmission(
            input.context,
            submissionId.value,
          ),
        ]);
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
      if (status.kind === 'rejected') {
        return {
          kind: 'rejected',
          reason:
            status.reason === 'owner-mismatch'
              ? 'owner-mismatch'
              : 'unavailable',
        };
      }
      if (record === undefined) {
        return { kind: 'rejected', reason: 'terms-consent-required' };
      }
      if (!termsConsentRecordMatchesContext(record, input.context)) {
        return { kind: 'rejected', reason: 'owner-mismatch' };
      }
      if (
        record.snapshot.termsVersion !== status.status.current.termsVersion ||
        record.snapshot.termsHash !== status.status.current.termsHash
      ) {
        return { kind: 'rejected', reason: 'terms-changed' };
      }
      return { kind: 'accepted', consentId: record.consentId };
    },
  };
}
