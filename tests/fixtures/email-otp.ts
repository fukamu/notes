import {
  parseEmailOtpAddress,
  parseEmailOtpChallengeId,
  parseEmailOtpCode,
  parseEmailOtpDigest,
  parseEmailOtpRateLimitKey,
  parseEmailOtpSalt,
} from '@/lib/domain/email-otp';
import type {
  EmailOtpChallenge,
  EmailOtpIdentityRecord,
  PendingEmailOtpChallenge,
} from '@/server/core/email-otp';
import { sessionFixtureIds } from '@/tests/fixtures/session';

export const emailOtpFixture = {
  challengeId: parseEmailOtpChallengeId('01991f20-61d2-7000-8000-000000000501'),
  otherChallengeId: parseEmailOtpChallengeId(
    '01991f20-61d2-7000-8000-000000000502',
  ),
  address: parseEmailOtpAddress('Person@Example.com'),
  otherAddress: parseEmailOtpAddress('other@example.com'),
  code: parseEmailOtpCode('12345678'),
  otherCode: parseEmailOtpCode('87654321'),
  salt: parseEmailOtpSalt('A'.repeat(43)),
  otherSalt: parseEmailOtpSalt(`${'B'.repeat(42)}A`),
  digest: parseEmailOtpDigest(`${'C'.repeat(42)}A`),
  addressKey: parseEmailOtpRateLimitKey(`${'D'.repeat(42)}A`),
  networkKey: parseEmailOtpRateLimitKey(`${'E'.repeat(42)}A`),
  accountKey: parseEmailOtpRateLimitKey(`${'F'.repeat(42)}A`),
} as const;

export function fixturePendingEmailOtp(
  overrides: Partial<PendingEmailOtpChallenge> = {},
): PendingEmailOtpChallenge {
  return {
    kind: 'pending',
    challengeId: emailOtpFixture.challengeId,
    address: emailOtpFixture.address,
    digest: emailOtpFixture.digest,
    salt: emailOtpFixture.salt,
    purpose: { kind: 'sign-in' },
    createdAtEpochSeconds: 1_000,
    expiresAtEpochSeconds: 1_600,
    failedAttempts: 0,
    sendCount: 1,
    lastSentAtEpochSeconds: 1_000,
    version: 1,
    ...overrides,
  };
}

export function fixtureEmailOtpChallenge(
  overrides: Partial<PendingEmailOtpChallenge> = {},
): EmailOtpChallenge {
  return fixturePendingEmailOtp(overrides);
}

export const emailOtpIdentityRecord: EmailOtpIdentityRecord = {
  identityId: sessionFixtureIds.identityId,
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  address: emailOtpFixture.address,
};
