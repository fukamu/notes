import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  decodeOrThrow,
  literalDecoder,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core';
import type { PrivacyRequestKind } from '../domain/privacy-request';

declare const privacyRequestIdentifierBrand: unique symbol;

type PrivacyRequestIdentifier<TName extends string> = string & {
  readonly [privacyRequestIdentifierBrand]: TName;
};

export type PrivacyRequestId = PrivacyRequestIdentifier<'PrivacyRequestId'>;
export type PrivacyRequestSubmissionId =
  PrivacyRequestIdentifier<'PrivacyRequestSubmissionId'>;
export type PrivacyRequestOutcome = 'fulfilled' | 'account-deletion-started';

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

function brandedUuidDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(uuidV7Decoder, (value) => value as TValue);
}

export const privacyRequestIdDecoder = brandedUuidDecoder<PrivacyRequestId>();
export const privacyRequestSubmissionIdDecoder =
  brandedUuidDecoder<PrivacyRequestSubmissionId>();

export const privacyRequestKindDecoder: Decoder<PrivacyRequestKind> =
  unionDecoder(
    literalDecoder('purpose-notification'),
    literalDecoder('disclosure'),
    literalDecoder('correction'),
    literalDecoder('usage-suspension'),
    literalDecoder('deletion'),
    literalDecoder('third-party-provision-suspension'),
  );

export const privacyRequestOutcomeDecoder: Decoder<PrivacyRequestOutcome> =
  unionDecoder(
    literalDecoder('fulfilled'),
    literalDecoder('account-deletion-started'),
  );

export function parsePrivacyRequestId(input: unknown): PrivacyRequestId {
  return decodeOrThrow(privacyRequestIdDecoder, input, 'PrivacyRequestId');
}

export function parsePrivacyRequestSubmissionId(
  input: unknown,
): PrivacyRequestSubmissionId {
  return decodeOrThrow(
    privacyRequestSubmissionIdDecoder,
    input,
    'PrivacyRequestSubmissionId',
  );
}
