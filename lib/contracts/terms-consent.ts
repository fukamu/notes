import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core';
import type { VaultContext } from '../domain/identity';

declare const termsConsentIdentifierBrand: unique symbol;
declare const termsDocumentHashBrand: unique symbol;
declare const termsVersionBrand: unique symbol;

type TermsConsentIdentifier<TName extends string> = string & {
  readonly [termsConsentIdentifierBrand]: TName;
};

export type TermsConsentId = TermsConsentIdentifier<'TermsConsentId'>;
export type TermsConsentSubmissionId =
  TermsConsentIdentifier<'TermsConsentSubmissionId'>;
export type TermsDocumentHash = string & {
  readonly [termsDocumentHashBrand]: 'TermsDocumentHash';
};
export type TermsVersion = string & {
  readonly [termsVersionBrand]: 'TermsVersion';
};
export type TermsConsentScope = Pick<VaultContext, 'accountId' | 'vaultId'>;

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

function brandedUuidDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(
    uuidV7Decoder,
    // The UUIDv7 runtime guard above is the proof for this identifier brand.
    (value) => value as TValue,
  );
}

export const termsConsentIdDecoder = brandedUuidDecoder<TermsConsentId>();
export const termsConsentSubmissionIdDecoder =
  brandedUuidDecoder<TermsConsentSubmissionId>();
export const termsDocumentHashDecoder: Decoder<TermsDocumentHash> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 71, maxLength: 71 }),
      (value) => /^sha256:[a-f0-9]{64}$/.test(value),
      'expected a lowercase SHA-256 digest',
    ),
    (value) => value as TermsDocumentHash,
  );
export const termsVersionDecoder: Decoder<TermsVersion> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 19, maxLength: 19 }),
    (value) => /^terms-v1:\d{4}-\d{2}-\d{2}$/.test(value),
    'expected terms-v1:YYYY-MM-DD',
  ),
  (value) => value as TermsVersion,
);

export function parseTermsConsentId(input: unknown): TermsConsentId {
  return decodeOrThrow(termsConsentIdDecoder, input, 'TermsConsentId');
}

export function parseTermsConsentSubmissionId(
  input: unknown,
): TermsConsentSubmissionId {
  return decodeOrThrow(
    termsConsentSubmissionIdDecoder,
    input,
    'TermsConsentSubmissionId',
  );
}

export function parseTermsDocumentHash(input: unknown): TermsDocumentHash {
  return decodeOrThrow(termsDocumentHashDecoder, input, 'TermsDocumentHash');
}

export function parseTermsVersion(input: unknown): TermsVersion {
  return decodeOrThrow(termsVersionDecoder, input, 'TermsVersion');
}

export type TermsConsentChoice =
  | { readonly kind: 'not-affirmed' }
  | { readonly kind: 'affirmed' };

export type TermsConsentCommand = Readonly<{
  submissionId: TermsConsentSubmissionId;
  presentedTermsVersion: TermsVersion;
  presentedTermsHash: TermsDocumentHash;
  consent: TermsConsentChoice;
}>;

export const termsConsentCommandDecoder: Decoder<TermsConsentCommand> =
  objectDecoder({
    submissionId: termsConsentSubmissionIdDecoder,
    presentedTermsVersion: termsVersionDecoder,
    presentedTermsHash: termsDocumentHashDecoder,
    consent: unionDecoder(
      objectDecoder({ kind: literalDecoder('not-affirmed') }),
      objectDecoder({ kind: literalDecoder('affirmed') }),
    ),
  });
