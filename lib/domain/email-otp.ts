import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  decodeOrThrow,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../codec/core';

declare const emailOtpBrand: unique symbol;

type EmailOtpValue<TName extends string> = string & {
  readonly [emailOtpBrand]: TName;
};

export type EmailOtpChallengeId = EmailOtpValue<'EmailOtpChallengeId'>;
export type EmailOtpAddress = EmailOtpValue<'EmailOtpAddress'>;
export type EmailOtpCode = EmailOtpValue<'EmailOtpCode'>;
export type EmailOtpSalt = EmailOtpValue<'EmailOtpSalt'>;
export type EmailOtpDigest = EmailOtpValue<'EmailOtpDigest'>;
export type EmailOtpRateLimitKey = EmailOtpValue<'EmailOtpRateLimitKey'>;

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

const canonicalBase64Url256Decoder = refineDecoder(
  stringDecoder({ minLength: 43, maxLength: 43 }),
  (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
  'expected an unpadded 256-bit base64url value',
);

export const emailOtpChallengeIdDecoder: Decoder<EmailOtpChallengeId> =
  transformDecoder(uuidV7Decoder, (value) => value as EmailOtpChallengeId);

export const emailOtpAddressDecoder: Decoder<EmailOtpAddress> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 3, maxLength: 254 }),
      isBoundedAsciiEmailAddress,
      'expected a bounded ASCII email address',
    ),
    // Domain matching is case-insensitive. Local-part and provider-specific
    // alias folding (dots, plus tags, Unicode) are deliberately not changed.
    (value) => {
      const separator = value.lastIndexOf('@');
      return `${value.slice(0, separator)}@${value
        .slice(separator + 1)
        .toLowerCase()}` as EmailOtpAddress;
    },
  );

function isBoundedAsciiEmailAddress(value: string): boolean {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator !== value.indexOf('@')) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    local.length > 64 ||
    domain.length === 0 ||
    domain.length > 253 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return false;
  }
  return domain
    .split('.')
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export const emailOtpCodeDecoder: Decoder<EmailOtpCode> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 8, maxLength: 8 }),
    (value) => /^\d{8}$/.test(value),
    'expected an eight-digit OTP',
  ),
  (value) => value as EmailOtpCode,
);

export const emailOtpSaltDecoder: Decoder<EmailOtpSalt> = transformDecoder(
  canonicalBase64Url256Decoder,
  (value) => value as EmailOtpSalt,
);

export const emailOtpDigestDecoder: Decoder<EmailOtpDigest> = transformDecoder(
  canonicalBase64Url256Decoder,
  (value) => value as EmailOtpDigest,
);

export const emailOtpRateLimitKeyDecoder: Decoder<EmailOtpRateLimitKey> =
  transformDecoder(
    canonicalBase64Url256Decoder,
    (value) => value as EmailOtpRateLimitKey,
  );

export function parseEmailOtpChallengeId(input: unknown): EmailOtpChallengeId {
  return decodeOrThrow(
    emailOtpChallengeIdDecoder,
    input,
    'EmailOtpChallengeId',
  );
}

export function parseEmailOtpAddress(input: unknown): EmailOtpAddress {
  return decodeOrThrow(emailOtpAddressDecoder, input, 'EmailOtpAddress');
}

export function parseEmailOtpCode(input: unknown): EmailOtpCode {
  return decodeOrThrow(emailOtpCodeDecoder, input, 'EmailOtpCode');
}

export function parseEmailOtpSalt(input: unknown): EmailOtpSalt {
  return decodeOrThrow(emailOtpSaltDecoder, input, 'EmailOtpSalt');
}

export function parseEmailOtpDigest(input: unknown): EmailOtpDigest {
  return decodeOrThrow(emailOtpDigestDecoder, input, 'EmailOtpDigest');
}

export function parseEmailOtpRateLimitKey(
  input: unknown,
): EmailOtpRateLimitKey {
  return decodeOrThrow(
    emailOtpRateLimitKeyDecoder,
    input,
    'EmailOtpRateLimitKey',
  );
}
