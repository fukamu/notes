import type {
  TermsConsentAppendResult,
  TermsConsentRecord,
  TermsConsentRepository,
  TermsConsentScope,
  TermsConsentSubmissionId,
} from './public';
import { termsConsentRecordMatchesContext } from './core';

export function createFakeTermsConsentRepository(): TermsConsentRepository {
  const bySubmission = new Map<string, TermsConsentRecord>();
  const byConsent = new Map<string, TermsConsentRecord>();
  return {
    async findById(context, consentId) {
      return byConsent.get(key(context, consentId));
    },
    async findBySubmission(context, submissionId) {
      return bySubmission.get(key(context, submissionId));
    },
    async findLatest(context) {
      let latest: TermsConsentRecord | undefined;
      for (const record of byConsent.values()) {
        if (
          record.scope.accountId !== context.accountId ||
          record.scope.vaultId !== context.vaultId
        ) {
          continue;
        }
        if (
          latest === undefined ||
          record.acceptedAt > latest.acceptedAt ||
          (record.acceptedAt === latest.acceptedAt &&
            record.consentId > latest.consentId)
        ) {
          latest = record;
        }
      }
      return latest;
    },
    async append(context, record): Promise<TermsConsentAppendResult> {
      if (!termsConsentRecordMatchesContext(record, context)) {
        return { kind: 'rejected', reason: 'owner-mismatch' };
      }
      const submissionKey = key(record.scope, record.submissionId);
      const existing = bySubmission.get(submissionKey);
      if (existing !== undefined) {
        return { kind: 'existing', record: existing };
      }
      const consentKey = key(record.scope, record.consentId);
      if (byConsent.has(consentKey)) return { kind: 'conflict' };
      bySubmission.set(submissionKey, record);
      byConsent.set(consentKey, record);
      return { kind: 'created' };
    },
  };
}

function key(
  scope: TermsConsentScope,
  identifier: TermsConsentSubmissionId | TermsConsentRecord['consentId'],
): string {
  return `${scope.accountId}:${scope.vaultId}:${identifier}`;
}
