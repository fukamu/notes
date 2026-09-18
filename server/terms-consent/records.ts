import {
  BoundaryDecodeError,
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { decodeLegalTermsDisclosure } from '../../lib/application/legal-terms';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import { serializeTermsDisclosure } from './core';
import {
  termsConsentIdDecoder,
  termsConsentSubmissionIdDecoder,
  termsDocumentHashDecoder,
  termsVersionDecoder,
  type TermsConsentRecord,
} from './public';

export const termsConsentRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  consent_id: termsConsentIdDecoder,
  submission_id: termsConsentSubmissionIdDecoder,
  terms_version: termsVersionDecoder,
  terms_hash: termsDocumentHashDecoder,
  serialized_terms: stringDecoder({ minLength: 1, maxLength: 65_536 }),
  consent: literalDecoder('affirmed'),
  accepted_at: safeIntegerDecoder({ minimum: 0 }),
});

export type TermsConsentRow = InferDecoder<typeof termsConsentRowDecoder>;

export function mapTermsConsentRow(row: TermsConsentRow): TermsConsentRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.serialized_terms);
  } catch {
    invalidRow('serialized terms are not JSON');
  }
  const decoded = decodeLegalTermsDisclosure(candidate);
  if (decoded.kind === 'invalid') {
    throw new BoundaryDecodeError(
      'D1 terms consent disclosure',
      decoded.issues.map((reason) => ({ path: [], reason })),
    );
  }
  if (
    serializeTermsDisclosure(decoded.disclosure) !== row.serialized_terms ||
    decoded.disclosure.termsVersion !== row.terms_version
  ) {
    invalidRow('stored terms metadata are inconsistent');
  }
  return {
    scope: { accountId: row.account_id, vaultId: row.vault_id },
    consentId: row.consent_id,
    submissionId: row.submission_id,
    snapshot: {
      termsVersion: row.terms_version,
      termsHash: row.terms_hash,
      disclosure: decoded.disclosure,
      serializedTerms: row.serialized_terms,
    },
    consent: row.consent,
    acceptedAt: row.accepted_at,
  };
}

function invalidRow(reason: string): never {
  throw new BoundaryDecodeError('D1 terms consent row', [{ path: [], reason }]);
}
