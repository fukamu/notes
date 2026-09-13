import {
  literalDecoder,
  objectDecoder,
  optionalDecoder,
  refineDecoder,
  safeIntegerDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  emailOtpAddressDecoder,
  emailOtpChallengeIdDecoder,
  emailOtpDigestDecoder,
  emailOtpRateLimitKeyDecoder,
  emailOtpSaltDecoder,
  type EmailOtpAddress,
  type EmailOtpChallengeId,
  type EmailOtpDigest,
  type EmailOtpRateLimitKey,
  type EmailOtpSalt,
} from '../../lib/domain/email-otp';
import {
  accountIdDecoder,
  identityIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type IdentityId,
  type VaultId,
} from '../../lib/domain/identity';

export const EMAIL_OTP_TTL_SECONDS = 600;
export const EMAIL_OTP_RESEND_INTERVAL_SECONDS = 60;
export const EMAIL_OTP_MAX_FAILED_ATTEMPTS = 5;
export const EMAIL_OTP_MAX_SENDS = 3;
export const EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS = 3_600;

const epochSecondsDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const challengeVersionDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: 8,
});
const failedAttemptsDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: EMAIL_OTP_MAX_FAILED_ATTEMPTS,
});
const sendCountDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: EMAIL_OTP_MAX_SENDS,
});

export type EmailOtpPurpose =
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'link'; readonly accountId: AccountId };

const emailOtpPurposeDecoder = unionDecoder(
  objectDecoder({ kind: literalDecoder('sign-in') }),
  objectDecoder({ kind: literalDecoder('link'), accountId: accountIdDecoder }),
);

type EmailOtpChallengeCommon = {
  readonly challengeId: EmailOtpChallengeId;
  readonly address: EmailOtpAddress;
  readonly digest: EmailOtpDigest;
  readonly salt: EmailOtpSalt;
  readonly purpose: EmailOtpPurpose;
  readonly createdAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly failedAttempts: number;
  readonly sendCount: number;
  readonly lastSentAtEpochSeconds: number;
  readonly version: number;
};

export type PendingEmailOtpChallenge = EmailOtpChallengeCommon & {
  readonly kind: 'pending';
};

export type EmailOtpChallenge =
  | PendingEmailOtpChallenge
  | (EmailOtpChallengeCommon & {
      readonly kind: 'consumed';
      readonly consumedAtEpochSeconds: number;
    })
  | (EmailOtpChallengeCommon & {
      readonly kind: 'locked';
      readonly lockedAtEpochSeconds: number;
    })
  | (EmailOtpChallengeCommon & {
      readonly kind: 'invalidated';
      readonly invalidatedAtEpochSeconds: number;
      readonly reason: 'delivery-failed' | 'expired' | 'superseded';
    });

const challengeCommonShape = {
  challengeId: emailOtpChallengeIdDecoder,
  address: emailOtpAddressDecoder,
  digest: emailOtpDigestDecoder,
  salt: emailOtpSaltDecoder,
  purpose: emailOtpPurposeDecoder,
  createdAtEpochSeconds: epochSecondsDecoder,
  expiresAtEpochSeconds: epochSecondsDecoder,
  failedAttempts: failedAttemptsDecoder,
  sendCount: sendCountDecoder,
  lastSentAtEpochSeconds: epochSecondsDecoder,
  version: challengeVersionDecoder,
};

const emailOtpChallengeShapeDecoder = unionDecoder(
  objectDecoder({ kind: literalDecoder('pending'), ...challengeCommonShape }),
  objectDecoder({
    kind: literalDecoder('consumed'),
    ...challengeCommonShape,
    consumedAtEpochSeconds: epochSecondsDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('locked'),
    ...challengeCommonShape,
    lockedAtEpochSeconds: epochSecondsDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('invalidated'),
    ...challengeCommonShape,
    invalidatedAtEpochSeconds: epochSecondsDecoder,
    reason: unionDecoder(
      literalDecoder('delivery-failed'),
      literalDecoder('expired'),
      literalDecoder('superseded'),
    ),
  }),
);

export const emailOtpChallengeDecoder: Decoder<EmailOtpChallenge> =
  transformDecoder(
    refineDecoder(
      emailOtpChallengeShapeDecoder,
      hasValidChallengeTimeline,
      'expected a consistent, bounded Email OTP challenge',
    ),
    (challenge): EmailOtpChallenge => challenge,
  );

function hasValidChallengeTimeline(challenge: EmailOtpChallenge): boolean {
  if (
    challenge.expiresAtEpochSeconds <= challenge.createdAtEpochSeconds ||
    challenge.expiresAtEpochSeconds - challenge.createdAtEpochSeconds !==
      EMAIL_OTP_TTL_SECONDS ||
    challenge.lastSentAtEpochSeconds < challenge.createdAtEpochSeconds ||
    challenge.lastSentAtEpochSeconds >= challenge.expiresAtEpochSeconds
  ) {
    return false;
  }
  if (challenge.kind === 'pending') {
    return (
      challenge.failedAttempts < EMAIL_OTP_MAX_FAILED_ATTEMPTS &&
      challenge.version === challenge.sendCount + challenge.failedAttempts
    );
  }
  if (challenge.kind === 'locked') {
    return (
      challenge.failedAttempts === EMAIL_OTP_MAX_FAILED_ATTEMPTS &&
      challenge.lockedAtEpochSeconds >= challenge.lastSentAtEpochSeconds &&
      challenge.lockedAtEpochSeconds < challenge.expiresAtEpochSeconds &&
      challenge.version === challenge.sendCount + challenge.failedAttempts
    );
  }
  if (challenge.failedAttempts >= EMAIL_OTP_MAX_FAILED_ATTEMPTS) return false;
  const terminalAt =
    challenge.kind === 'consumed'
      ? challenge.consumedAtEpochSeconds
      : challenge.invalidatedAtEpochSeconds;
  if (challenge.kind === 'invalidated' && challenge.reason === 'expired') {
    return (
      terminalAt >= challenge.expiresAtEpochSeconds &&
      challenge.version === challenge.sendCount + challenge.failedAttempts + 1
    );
  }
  return (
    terminalAt >= challenge.lastSentAtEpochSeconds &&
    terminalAt < challenge.expiresAtEpochSeconds &&
    challenge.version === challenge.sendCount + challenge.failedAttempts + 1
  );
}

export type CreateEmailOtpChallengeDecision =
  | { readonly kind: 'created'; readonly challenge: PendingEmailOtpChallenge }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-clock' };

export function createEmailOtpChallenge(input: {
  readonly challengeId: EmailOtpChallengeId;
  readonly address: EmailOtpAddress;
  readonly digest: EmailOtpDigest;
  readonly salt: EmailOtpSalt;
  readonly purpose: EmailOtpPurpose;
  readonly nowEpochSeconds: number;
}): CreateEmailOtpChallengeDecision {
  if (!canAddSeconds(input.nowEpochSeconds, EMAIL_OTP_TTL_SECONDS)) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  return {
    kind: 'created',
    challenge: {
      kind: 'pending',
      challengeId: input.challengeId,
      address: input.address,
      digest: input.digest,
      salt: input.salt,
      purpose: input.purpose,
      createdAtEpochSeconds: input.nowEpochSeconds,
      expiresAtEpochSeconds: input.nowEpochSeconds + EMAIL_OTP_TTL_SECONDS,
      failedAttempts: 0,
      sendCount: 1,
      lastSentAtEpochSeconds: input.nowEpochSeconds,
      version: 1,
    },
  };
}

export type VerifyEmailOtpChallengeDecision =
  | {
      readonly kind: 'verified';
      readonly challenge: Extract<EmailOtpChallenge, { kind: 'consumed' }>;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-clock'
        | 'expired'
        | 'incorrect-code'
        | 'not-pending';
      readonly challenge?: EmailOtpChallenge;
    };

export function verifyEmailOtpChallenge(input: {
  readonly challenge: EmailOtpChallenge;
  readonly digestMatches: boolean;
  readonly nowEpochSeconds: number;
}): VerifyEmailOtpChallengeDecision {
  if (!validEpoch(input.nowEpochSeconds)) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (input.challenge.kind !== 'pending') {
    return { kind: 'rejected', reason: 'not-pending' };
  }
  if (input.nowEpochSeconds < input.challenge.createdAtEpochSeconds) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (input.nowEpochSeconds >= input.challenge.expiresAtEpochSeconds) {
    return {
      kind: 'rejected',
      reason: 'expired',
      challenge: {
        ...input.challenge,
        kind: 'invalidated',
        reason: 'expired',
        invalidatedAtEpochSeconds: input.nowEpochSeconds,
        version: nextVersion(input.challenge.version),
      },
    };
  }
  if (input.digestMatches) {
    return {
      kind: 'verified',
      challenge: {
        ...input.challenge,
        kind: 'consumed',
        consumedAtEpochSeconds: input.nowEpochSeconds,
        version: nextVersion(input.challenge.version),
      },
    };
  }
  const failedAttempts = input.challenge.failedAttempts + 1;
  if (failedAttempts >= EMAIL_OTP_MAX_FAILED_ATTEMPTS) {
    return {
      kind: 'rejected',
      reason: 'incorrect-code',
      challenge: {
        ...input.challenge,
        kind: 'locked',
        failedAttempts: EMAIL_OTP_MAX_FAILED_ATTEMPTS,
        lockedAtEpochSeconds: input.nowEpochSeconds,
        version: nextVersion(input.challenge.version),
      },
    };
  }
  return {
    kind: 'rejected',
    reason: 'incorrect-code',
    challenge: {
      ...input.challenge,
      failedAttempts,
      version: nextVersion(input.challenge.version),
    },
  };
}

export type ResendEmailOtpChallengeDecision =
  | { readonly kind: 'resent'; readonly challenge: PendingEmailOtpChallenge }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-clock'
        | 'not-pending'
        | 'expired'
        | 'too-soon'
        | 'send-limit';
      readonly challenge?: EmailOtpChallenge;
    };

export function resendEmailOtpChallenge(input: {
  readonly challenge: EmailOtpChallenge;
  readonly digest: EmailOtpDigest;
  readonly salt: EmailOtpSalt;
  readonly nowEpochSeconds: number;
}): ResendEmailOtpChallengeDecision {
  if (!validEpoch(input.nowEpochSeconds)) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (input.challenge.kind !== 'pending') {
    return { kind: 'rejected', reason: 'not-pending' };
  }
  if (input.nowEpochSeconds < input.challenge.createdAtEpochSeconds) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (input.nowEpochSeconds >= input.challenge.expiresAtEpochSeconds) {
    return {
      kind: 'rejected',
      reason: 'expired',
      challenge: {
        ...input.challenge,
        kind: 'invalidated',
        reason: 'expired',
        invalidatedAtEpochSeconds: input.nowEpochSeconds,
        version: nextVersion(input.challenge.version),
      },
    };
  }
  if (
    input.nowEpochSeconds - input.challenge.lastSentAtEpochSeconds <
    EMAIL_OTP_RESEND_INTERVAL_SECONDS
  ) {
    return { kind: 'rejected', reason: 'too-soon' };
  }
  if (input.challenge.sendCount >= EMAIL_OTP_MAX_SENDS) {
    return { kind: 'rejected', reason: 'send-limit' };
  }
  return {
    kind: 'resent',
    challenge: {
      ...input.challenge,
      digest: input.digest,
      salt: input.salt,
      sendCount: input.challenge.sendCount + 1,
      lastSentAtEpochSeconds: input.nowEpochSeconds,
      version: nextVersion(input.challenge.version),
    },
  };
}

export function invalidateEmailOtpDelivery(
  challenge: PendingEmailOtpChallenge,
  nowEpochSeconds: number,
): EmailOtpChallenge | undefined {
  if (
    !validEpoch(nowEpochSeconds) ||
    nowEpochSeconds < challenge.createdAtEpochSeconds ||
    nowEpochSeconds >= challenge.expiresAtEpochSeconds
  ) {
    return undefined;
  }
  return {
    ...challenge,
    kind: 'invalidated',
    reason: 'delivery-failed',
    invalidatedAtEpochSeconds: nowEpochSeconds,
    version: nextVersion(challenge.version),
  };
}

export type EmailOtpRateLimitBucket = {
  readonly key: EmailOtpRateLimitKey;
  readonly count: number;
  readonly windowStartedAtEpochSeconds: number;
};

const rateLimitBucketDecoder = objectDecoder({
  key: emailOtpRateLimitKeyDecoder,
  count: safeIntegerDecoder({ minimum: 0, maximum: 1_000_000 }),
  windowStartedAtEpochSeconds: epochSecondsDecoder,
});

export type EmailOtpRateLimitState = {
  readonly address: EmailOtpRateLimitBucket;
  readonly network: EmailOtpRateLimitBucket;
  readonly account?: EmailOtpRateLimitBucket;
};

export const emailOtpRateLimitStateDecoder: Decoder<EmailOtpRateLimitState> =
  transformDecoder(
    objectDecoder({
      address: rateLimitBucketDecoder,
      network: rateLimitBucketDecoder,
      account: optionalDecoder(rateLimitBucketDecoder),
    }),
    (state): EmailOtpRateLimitState => ({
      address: state.address,
      network: state.network,
      ...(state.account === undefined ? {} : { account: state.account }),
    }),
  );

const rateLimitMaximums = {
  address: 5,
  network: 30,
  account: 5,
} as const;

export type ReserveEmailOtpRateLimitDecision =
  | { readonly kind: 'reserved'; readonly state: EmailOtpRateLimitState }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-clock' | 'limited' };

export function reserveEmailOtpRateLimit(
  state: EmailOtpRateLimitState,
  nowEpochSeconds: number,
): ReserveEmailOtpRateLimitDecision {
  if (!validEpoch(nowEpochSeconds)) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (
    state.address.windowStartedAtEpochSeconds > nowEpochSeconds ||
    state.network.windowStartedAtEpochSeconds > nowEpochSeconds ||
    (state.account !== undefined &&
      state.account.windowStartedAtEpochSeconds > nowEpochSeconds)
  ) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  const normalized = {
    address: normalizeBucket(state.address, nowEpochSeconds),
    network: normalizeBucket(state.network, nowEpochSeconds),
    ...(state.account === undefined
      ? {}
      : { account: normalizeBucket(state.account, nowEpochSeconds) }),
  };
  if (
    normalized.address.count >= rateLimitMaximums.address ||
    normalized.network.count >= rateLimitMaximums.network ||
    (normalized.account !== undefined &&
      normalized.account.count >= rateLimitMaximums.account)
  ) {
    return { kind: 'rejected', reason: 'limited' };
  }
  return {
    kind: 'reserved',
    state: {
      address: incrementBucket(normalized.address),
      network: incrementBucket(normalized.network),
      ...(normalized.account === undefined
        ? {}
        : { account: incrementBucket(normalized.account) }),
    },
  };
}

function normalizeBucket(
  bucket: EmailOtpRateLimitBucket,
  nowEpochSeconds: number,
): EmailOtpRateLimitBucket {
  return nowEpochSeconds - bucket.windowStartedAtEpochSeconds >=
    EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS
    ? { ...bucket, count: 0, windowStartedAtEpochSeconds: nowEpochSeconds }
    : bucket;
}

function incrementBucket(
  bucket: EmailOtpRateLimitBucket,
): EmailOtpRateLimitBucket {
  return { ...bucket, count: bucket.count + 1 };
}

export type EmailOtpIdentityRecord = {
  readonly identityId: IdentityId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly address: EmailOtpAddress;
};

export const emailOtpIdentityRecordDecoder: Decoder<EmailOtpIdentityRecord> =
  transformDecoder(
    objectDecoder({
      identityId: identityIdDecoder,
      accountId: accountIdDecoder,
      vaultId: vaultIdDecoder,
      address: emailOtpAddressDecoder,
    }),
    (identity): EmailOtpIdentityRecord => identity,
  );

export type EmailOtpIdentityResolution =
  | {
      readonly kind: 'authenticate-existing';
      readonly identity: EmailOtpIdentityRecord;
    }
  | { readonly kind: 'provision-account'; readonly address: EmailOtpAddress }
  | {
      readonly kind: 'link-identity';
      readonly accountId: AccountId;
      readonly address: EmailOtpAddress;
    }
  | {
      readonly kind: 'already-linked';
      readonly identity: EmailOtpIdentityRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'identity-record-mismatch'
        | 'identity-owned-by-another-account'
        | 'email-collision';
    };

export function decideEmailOtpIdentityResolution(input: {
  readonly purpose: EmailOtpPurpose;
  readonly address: EmailOtpAddress;
  readonly existingIdentity?: EmailOtpIdentityRecord;
  readonly verifiedContactAccountId?: AccountId;
}): EmailOtpIdentityResolution {
  const { existingIdentity, purpose, verifiedContactAccountId } = input;
  if (existingIdentity && existingIdentity.address !== input.address) {
    return { kind: 'rejected', reason: 'identity-record-mismatch' };
  }
  if (purpose.kind === 'sign-in') {
    if (existingIdentity) {
      return { kind: 'authenticate-existing', identity: existingIdentity };
    }
    return verifiedContactAccountId
      ? { kind: 'rejected', reason: 'email-collision' }
      : { kind: 'provision-account', address: input.address };
  }
  if (existingIdentity) {
    return existingIdentity.accountId === purpose.accountId
      ? { kind: 'already-linked', identity: existingIdentity }
      : { kind: 'rejected', reason: 'identity-owned-by-another-account' };
  }
  if (
    verifiedContactAccountId !== undefined &&
    verifiedContactAccountId !== purpose.accountId
  ) {
    return { kind: 'rejected', reason: 'email-collision' };
  }
  return {
    kind: 'link-identity',
    accountId: purpose.accountId,
    address: input.address,
  };
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canAddSeconds(value: number, seconds: number): boolean {
  return validEpoch(value) && value <= Number.MAX_SAFE_INTEGER - seconds;
}

function nextVersion(version: number): number {
  return version + 1;
}
