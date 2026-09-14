import type {
  CurrentTermsSourcePort,
  TermsDocumentHasherPort,
  TermsConsentAppendResult,
  TermsConsentRecord,
  TermsConsentRepository,
  TermsConsentScope,
  TermsConsentSubmissionId,
} from './public';
import { termsConsentRecordMatchesContext } from './core';
import { localLegalTermsFixture } from '../../lib/application/legal-terms';
import { createTermsConsentApplication } from './application';
import { parseTermsDocumentHash } from './public';

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

export class FakeCurrentTermsSource implements CurrentTermsSourcePort {
  constructor(private value: unknown) {}

  set(value: unknown): void {
    this.value = value;
  }

  readCurrent(): unknown {
    return this.value;
  }
}

export class FakeTermsDocumentHasher implements TermsDocumentHasherPort {
  readonly calls: string[] = [];

  constructor(private value: unknown) {}

  set(value: unknown): void {
    this.value = value;
  }

  async hash(serializedTerms: string): Promise<unknown> {
    this.calls.push(serializedTerms);
    return this.value;
  }
}

export function createFakeTermsConsentModule() {
  const repository = createFakeTermsConsentRepository();
  const source = new FakeCurrentTermsSource({
    disclosure: localLegalTermsFixture,
    acceptancePolicy: { kind: 'initial-release' },
  });
  const hasher = new FakeTermsDocumentHasher(
    parseTermsDocumentHash(`sha256:${'a'.repeat(64)}`),
  );
  return {
    repository,
    source,
    hasher,
    application: createTermsConsentApplication({
      repository,
      source,
      hasher,
    }),
  };
}

function key(
  scope: TermsConsentScope,
  identifier: TermsConsentSubmissionId | TermsConsentRecord['consentId'],
): string {
  return `${scope.accountId}:${scope.vaultId}:${identifier}`;
}
