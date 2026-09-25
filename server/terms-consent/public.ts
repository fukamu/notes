import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  stringDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { LegalTermsDisclosure } from '../../lib/application/legal-terms';
import type { VaultContext } from '../../lib/domain/identity';
import type {
  TermsConsentId,
  TermsConsentScope,
  TermsConsentSubmissionId,
  TermsDocumentHash,
  TermsVersion,
} from '../../lib/contracts/terms-consent';

export {
  parseTermsConsentId,
  parseTermsConsentSubmissionId,
  parseTermsDocumentHash,
  parseTermsVersion,
  termsConsentCommandDecoder,
  termsConsentIdDecoder,
  termsConsentSubmissionIdDecoder,
  termsDocumentHashDecoder,
  termsVersionDecoder,
  type TermsConsentChoice,
  type TermsConsentCommand,
  type TermsConsentId,
  type TermsConsentScope,
  type TermsConsentSubmissionId,
  type TermsDocumentHash,
  type TermsVersion,
} from '../../lib/contracts/terms-consent';

export type TermsConsentSnapshot = Readonly<{
  termsVersion: TermsVersion;
  termsHash: TermsDocumentHash;
  disclosure: LegalTermsDisclosure;
  serializedTerms: string;
}>;

export type TermsConsentRecord = Readonly<{
  scope: TermsConsentScope;
  consentId: TermsConsentId;
  submissionId: TermsConsentSubmissionId;
  snapshot: TermsConsentSnapshot;
  consent: 'affirmed';
  acceptedAt: number;
}>;

export type TermsConsentAppendResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'existing'; readonly record: TermsConsentRecord }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rejected'; readonly reason: 'owner-mismatch' };

export type TermsConsentRepository = {
  findById(
    context: TermsConsentScope,
    consentId: TermsConsentId,
  ): Promise<TermsConsentRecord | undefined>;
  findBySubmission(
    context: TermsConsentScope,
    submissionId: TermsConsentSubmissionId,
  ): Promise<TermsConsentRecord | undefined>;
  findLatest(
    context: TermsConsentScope,
  ): Promise<TermsConsentRecord | undefined>;
  append(
    context: TermsConsentScope,
    record: TermsConsentRecord,
  ): Promise<TermsConsentAppendResult>;
};

export type TermsAcceptancePolicy =
  | { readonly kind: 'initial-release' }
  | {
      readonly kind: 'reconsent-required';
      readonly legalReviewId: string;
    }
  | { readonly kind: 'notice-only'; readonly legalReviewId: string }
  | { readonly kind: 'undecided' };

const legalReviewIdDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 128 }),
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value),
  'expected a non-sensitive legal review reference',
);

export const termsAcceptancePolicyDecoder: Decoder<TermsAcceptancePolicy> =
  unionDecoder(
    objectDecoder({ kind: literalDecoder('initial-release') }),
    objectDecoder({
      kind: literalDecoder('reconsent-required'),
      legalReviewId: legalReviewIdDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('notice-only'),
      legalReviewId: legalReviewIdDecoder,
    }),
    objectDecoder({ kind: literalDecoder('undecided') }),
  );

const unknownValueDecoder: Decoder<unknown> = {
  decode(input) {
    return { ok: true, value: input };
  },
};

export type CurrentTermsSourceValue = Readonly<{
  disclosure: unknown;
  acceptancePolicy: TermsAcceptancePolicy;
}>;

export const currentTermsSourceValueDecoder: Decoder<CurrentTermsSourceValue> =
  objectDecoder({
    disclosure: unknownValueDecoder,
    acceptancePolicy: termsAcceptancePolicyDecoder,
  });

export type CurrentTermsSourcePort = {
  readCurrent(): unknown;
};

export type TermsDocumentHasherPort = {
  hash(serializedTerms: string): Promise<unknown>;
};

export type TermsConsentCheckoutVerification =
  | { readonly kind: 'accepted'; readonly consentId: TermsConsentId }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'terms-consent-required'
        | 'terms-changed'
        | 'owner-mismatch'
        | 'unavailable';
    };

export type TermsConsentCheckoutVerifierPort = {
  verify(input: {
    readonly context: VaultContext;
    readonly submissionId: unknown;
  }): Promise<TermsConsentCheckoutVerification>;
};
