import {
  objectDecoder,
  optionalDecoder,
  transformDecoder,
  type Decoder,
} from '../lib/codec/core';
import {
  emailOtpAddressDecoder,
  emailOtpChallengeIdDecoder,
  emailOtpCodeDecoder,
  emailOtpDigestDecoder,
  emailOtpRateLimitKeyDecoder,
  emailOtpSaltDecoder,
  type EmailOtpAddress,
  type EmailOtpChallengeId,
  type EmailOtpCode,
  type EmailOtpDigest,
  type EmailOtpRateLimitKey,
  type EmailOtpSalt,
} from '../lib/domain/email-otp';
import {
  accountIdDecoder,
  type AccountId,
  type VaultContext,
} from '../lib/domain/identity';
import {
  createEmailOtpChallenge,
  decideEmailOtpIdentityResolution,
  emailOtpChallengeDecoder,
  emailOtpIdentityRecordDecoder,
  invalidateEmailOtpDelivery,
  resendEmailOtpChallenge,
  verifyEmailOtpChallenge,
  type EmailOtpChallenge,
  type EmailOtpIdentityRecord,
  type EmailOtpIdentityResolution,
  type EmailOtpPurpose,
  type PendingEmailOtpChallenge,
} from './core/email-otp';
import { termsConsentCommandDecoder } from './terms-consent/public';
import type {
  SignupAdmissionPort,
  SignupAdmissionReceipt,
} from './signup-admission/public';

export type EmailOtpClockPort = {
  nowEpochSeconds: () => unknown;
};

export type EmailOtpSecretPort = {
  createChallengeId: () => Promise<unknown>;
  createCode: () => Promise<unknown>;
  createSalt: () => Promise<unknown>;
};

export type EmailOtpHashInput = {
  readonly challengeId: EmailOtpChallengeId;
  readonly address: EmailOtpAddress;
  readonly code: EmailOtpCode;
  readonly salt: EmailOtpSalt;
};

export type EmailOtpHasherPort = {
  /** Production adapters must use a server-held pepper and timing-safe checks. */
  createDigest: (input: EmailOtpHashInput) => Promise<unknown>;
  matchesDigest: (
    input: EmailOtpHashInput & { readonly expectedDigest: EmailOtpDigest },
  ) => Promise<unknown>;
};

export type EmailOtpChallengeStore = {
  insertPending: (challenge: PendingEmailOtpChallenge) => Promise<void>;
  findById: (challengeId: EmailOtpChallengeId) => Promise<unknown>;
  /** Atomically replaces only the expected version. */
  compareAndSwap: (
    challengeId: EmailOtpChallengeId,
    expectedVersion: number,
    next: EmailOtpChallenge,
  ) => Promise<unknown>;
};

export type EmailOtpRateLimitKeys = {
  readonly address: EmailOtpRateLimitKey;
  readonly network: EmailOtpRateLimitKey;
  readonly account?: EmailOtpRateLimitKey;
};

const emailOtpRateLimitKeysDecoder: Decoder<EmailOtpRateLimitKeys> =
  transformDecoder(
    objectDecoder({
      address: emailOtpRateLimitKeyDecoder,
      network: emailOtpRateLimitKeyDecoder,
      account: optionalDecoder(emailOtpRateLimitKeyDecoder),
    }),
    (keys): EmailOtpRateLimitKeys => ({
      address: keys.address,
      network: keys.network,
      ...(keys.account === undefined ? {} : { account: keys.account }),
    }),
  );

export type EmailOtpRateLimitPort = {
  /** Production adapters must reserve address, network, and account atomically. */
  reserve: (
    keys: EmailOtpRateLimitKeys,
    nowEpochSeconds: number,
  ) => Promise<unknown>;
};

export type EmailOtpAbuseKeyInput = {
  readonly address: EmailOtpAddress;
  readonly accountId?: AccountId;
  /** Opaque request metadata interpreted only by the outer adapter. */
  readonly networkContext: unknown;
};

export type EmailOtpAbuseKeyPort = {
  /**
   * Production adapters derive non-reversible HMAC keys from the normalized
   * address, trusted account context, and request network context. Keys must
   * never be accepted from a request body.
   */
  deriveKeys: (input: EmailOtpAbuseKeyInput) => Promise<unknown>;
};

export type EmailOtpDeliveryInput = {
  readonly challengeId: EmailOtpChallengeId;
  readonly address: EmailOtpAddress;
  readonly code: EmailOtpCode;
  readonly expiresAtEpochSeconds: number;
};

export type EmailDeliveryPort = {
  sendOtp: (input: EmailOtpDeliveryInput) => Promise<void>;
};

export type EmailOtpIdentityDirectory = {
  findByAddress: (address: EmailOtpAddress) => Promise<unknown>;
  findAccountIdByVerifiedContact: (
    address: EmailOtpAddress,
  ) => Promise<unknown>;
};

export type EmailOtpStartIntent = 'sign-in' | 'link-current-account';

export type EmailOtpStartResult =
  | { readonly kind: 'accepted'; readonly challengeId: EmailOtpChallengeId }
  | { readonly kind: 'failed'; readonly error: 'authentication-unavailable' };

export async function startEmailOtp(input: {
  readonly address: unknown;
  readonly intent: EmailOtpStartIntent;
  readonly signupTermsConsent?: unknown;
  readonly vaultContext?: VaultContext;
  readonly networkContext: unknown;
  readonly clock: EmailOtpClockPort;
  readonly secrets: EmailOtpSecretPort;
  readonly hasher: EmailOtpHasherPort;
  readonly challenges: EmailOtpChallengeStore;
  readonly abuseKeys: EmailOtpAbuseKeyPort;
  readonly rateLimits: EmailOtpRateLimitPort;
  readonly delivery: EmailDeliveryPort;
}): Promise<EmailOtpStartResult> {
  let rawChallengeId: unknown;
  try {
    rawChallengeId = await input.secrets.createChallengeId();
  } catch {
    return authenticationUnavailable();
  }
  const challengeId = emailOtpChallengeIdDecoder.decode(rawChallengeId);
  if (!challengeId.ok) return authenticationUnavailable();

  const accepted = (): EmailOtpStartResult => ({
    kind: 'accepted',
    challengeId: challengeId.value,
  });
  try {
    const address = emailOtpAddressDecoder.decode(input.address);
    const signupTermsConsent =
      input.signupTermsConsent === undefined
        ? undefined
        : termsConsentCommandDecoder.decode(input.signupTermsConsent);
    const now = decodeEpoch(input.clock.nowEpochSeconds());
    const purpose = purposeFromStart(input.intent, input.vaultContext);
    if (
      !address.ok ||
      now === undefined ||
      !purpose ||
      (signupTermsConsent !== undefined && !signupTermsConsent.ok) ||
      (purpose.kind === 'link' && signupTermsConsent !== undefined)
    ) {
      return accepted();
    }
    const keys = emailOtpRateLimitKeysDecoder.decode(
      await input.abuseKeys.deriveKeys({
        address: address.value,
        ...(purpose.kind === 'link' ? { accountId: purpose.accountId } : {}),
        networkContext: input.networkContext,
      }),
    );
    if (!keys.ok) return accepted();
    if (purpose.kind === 'link' && keys.value.account === undefined) {
      return accepted();
    }
    const reserved = await input.rateLimits.reserve(keys.value, now);
    if (reserved !== true) return accepted();

    const [rawCode, rawSalt] = await Promise.all([
      input.secrets.createCode(),
      input.secrets.createSalt(),
    ]);
    const code = emailOtpCodeDecoder.decode(rawCode);
    const salt = emailOtpSaltDecoder.decode(rawSalt);
    if (!code.ok || !salt.ok) return accepted();
    const digest = emailOtpDigestDecoder.decode(
      await input.hasher.createDigest({
        challengeId: challengeId.value,
        address: address.value,
        code: code.value,
        salt: salt.value,
      }),
    );
    if (!digest.ok) return accepted();
    const created = createEmailOtpChallenge({
      challengeId: challengeId.value,
      address: address.value,
      digest: digest.value,
      salt: salt.value,
      purpose,
      ...(signupTermsConsent === undefined
        ? {}
        : { signupTermsConsent: signupTermsConsent.value }),
      nowEpochSeconds: now,
    });
    if (created.kind === 'rejected') return accepted();
    await input.challenges.insertPending(created.challenge);
    try {
      await input.delivery.sendOtp({
        challengeId: challengeId.value,
        address: address.value,
        code: code.value,
        expiresAtEpochSeconds: created.challenge.expiresAtEpochSeconds,
      });
    } catch {
      try {
        await invalidateAfterDeliveryFailure(
          input.challenges,
          created.challenge,
          now,
        );
      } catch {
        return accepted();
      }
    }
    return accepted();
  } catch {
    return accepted();
  }
}

export type EmailOtpCompletionResult =
  | {
      readonly kind: 'resolved';
      readonly resolution: Exclude<
        EmailOtpIdentityResolution,
        { readonly kind: 'rejected' | 'provision-account' }
      >;
    }
  | {
      readonly kind: 'admitted';
      readonly admission: SignupAdmissionReceipt;
    }
  | { readonly kind: 'failed'; readonly error: 'verification-failed' };

export async function completeEmailOtp(input: {
  readonly challengeId: unknown;
  readonly code: unknown;
  readonly clock: EmailOtpClockPort;
  readonly hasher: EmailOtpHasherPort;
  readonly challenges: EmailOtpChallengeStore;
  readonly identities: EmailOtpIdentityDirectory;
  readonly signupAdmission?: SignupAdmissionPort;
}): Promise<EmailOtpCompletionResult> {
  const challengeId = emailOtpChallengeIdDecoder.decode(input.challengeId);
  const code = emailOtpCodeDecoder.decode(input.code);
  const now = decodeEpoch(input.clock.nowEpochSeconds());
  if (!challengeId.ok || !code.ok || now === undefined) {
    return verificationFailed();
  }
  try {
    const challenge = emailOtpChallengeDecoder.decode(
      await input.challenges.findById(challengeId.value),
    );
    if (!challenge.ok || challenge.value.kind !== 'pending') {
      return verificationFailed();
    }
    const matches = await input.hasher.matchesDigest({
      challengeId: challenge.value.challengeId,
      address: challenge.value.address,
      code: code.value,
      salt: challenge.value.salt,
      expectedDigest: challenge.value.digest,
    });
    if (typeof matches !== 'boolean') return verificationFailed();
    const decision = verifyEmailOtpChallenge({
      challenge: challenge.value,
      digestMatches: matches,
      nowEpochSeconds: now,
    });
    if (decision.challenge !== undefined) {
      const swapped = await input.challenges.compareAndSwap(
        challenge.value.challengeId,
        challenge.value.version,
        decision.challenge,
      );
      if (swapped !== true) return verificationFailed();
    }
    if (decision.kind !== 'verified') return verificationFailed();

    const [rawIdentity, rawContactAccountId] = await Promise.all([
      input.identities.findByAddress(challenge.value.address),
      input.identities.findAccountIdByVerifiedContact(challenge.value.address),
    ]);
    const existingIdentity = optionalIdentity(rawIdentity);
    const verifiedContactAccountId = optionalAccountId(rawContactAccountId);
    if (!existingIdentity.ok || !verifiedContactAccountId.ok) {
      return verificationFailed();
    }
    const resolution = decideEmailOtpIdentityResolution({
      purpose: challenge.value.purpose,
      address: challenge.value.address,
      ...(existingIdentity.value === undefined
        ? {}
        : { existingIdentity: existingIdentity.value }),
      ...(verifiedContactAccountId.value === undefined
        ? {}
        : { verifiedContactAccountId: verifiedContactAccountId.value }),
    });
    if (resolution.kind === 'rejected') return verificationFailed();
    if (resolution.kind === 'provision-account') {
      if (
        challenge.value.signupTermsConsent === undefined ||
        input.signupAdmission === undefined
      ) {
        return verificationFailed();
      }
      const admission = await input.signupAdmission.admit({
        identity: { kind: 'email-otp', address: resolution.address },
        termsConsent: challenge.value.signupTermsConsent,
      });
      return admission.kind === 'admitted'
        ? { kind: 'admitted', admission: admission.receipt }
        : verificationFailed();
    }
    return { kind: 'resolved', resolution };
  } catch {
    return verificationFailed();
  }
}

export type EmailOtpResendResult = {
  readonly kind: 'accepted';
};

export async function resendEmailOtp(input: {
  readonly challengeId: unknown;
  readonly networkContext: unknown;
  readonly clock: EmailOtpClockPort;
  readonly secrets: EmailOtpSecretPort;
  readonly hasher: EmailOtpHasherPort;
  readonly challenges: EmailOtpChallengeStore;
  readonly abuseKeys: EmailOtpAbuseKeyPort;
  readonly rateLimits: EmailOtpRateLimitPort;
  readonly delivery: EmailDeliveryPort;
}): Promise<EmailOtpResendResult> {
  const accepted = { kind: 'accepted' } as const;
  const challengeId = emailOtpChallengeIdDecoder.decode(input.challengeId);
  const now = decodeEpoch(input.clock.nowEpochSeconds());
  if (!challengeId.ok || now === undefined) return accepted;
  try {
    const challenge = emailOtpChallengeDecoder.decode(
      await input.challenges.findById(challengeId.value),
    );
    if (!challenge.ok || challenge.value.kind !== 'pending') return accepted;
    const keys = emailOtpRateLimitKeysDecoder.decode(
      await input.abuseKeys.deriveKeys({
        address: challenge.value.address,
        ...(challenge.value.purpose.kind === 'link'
          ? { accountId: challenge.value.purpose.accountId }
          : {}),
        networkContext: input.networkContext,
      }),
    );
    if (!keys.ok) return accepted;
    if (
      challenge.value.purpose.kind === 'link' &&
      keys.value.account === undefined
    ) {
      return accepted;
    }
    const [rawCode, rawSalt] = await Promise.all([
      input.secrets.createCode(),
      input.secrets.createSalt(),
    ]);
    const code = emailOtpCodeDecoder.decode(rawCode);
    const salt = emailOtpSaltDecoder.decode(rawSalt);
    if (!code.ok || !salt.ok) return accepted;
    const digest = emailOtpDigestDecoder.decode(
      await input.hasher.createDigest({
        challengeId: challenge.value.challengeId,
        address: challenge.value.address,
        code: code.value,
        salt: salt.value,
      }),
    );
    if (!digest.ok) return accepted;
    const decision = resendEmailOtpChallenge({
      challenge: challenge.value,
      digest: digest.value,
      salt: salt.value,
      nowEpochSeconds: now,
    });
    if (decision.kind !== 'resent') {
      if (decision.challenge !== undefined) {
        await input.challenges.compareAndSwap(
          challenge.value.challengeId,
          challenge.value.version,
          decision.challenge,
        );
      }
      return accepted;
    }
    const reserved = await input.rateLimits.reserve(keys.value, now);
    if (reserved !== true) return accepted;
    const swapped = await input.challenges.compareAndSwap(
      challenge.value.challengeId,
      challenge.value.version,
      decision.challenge,
    );
    if (swapped !== true) return accepted;
    try {
      await input.delivery.sendOtp({
        challengeId: challenge.value.challengeId,
        address: challenge.value.address,
        code: code.value,
        expiresAtEpochSeconds: decision.challenge.expiresAtEpochSeconds,
      });
    } catch {
      try {
        await invalidateAfterDeliveryFailure(
          input.challenges,
          decision.challenge,
          now,
        );
      } catch {
        return accepted;
      }
    }
    return accepted;
  } catch {
    return accepted;
  }
}

type OptionalDecoded<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false };

function optionalIdentity(
  input: unknown,
): OptionalDecoded<EmailOtpIdentityRecord> {
  if (input === undefined) return { ok: true, value: undefined };
  const decoded = emailOtpIdentityRecordDecoder.decode(input);
  return decoded.ok ? { ok: true, value: decoded.value } : { ok: false };
}

function optionalAccountId(input: unknown): OptionalDecoded<AccountId> {
  if (input === undefined) return { ok: true, value: undefined };
  const decoded = accountIdDecoder.decode(input);
  return decoded.ok ? { ok: true, value: decoded.value } : { ok: false };
}

function purposeFromStart(
  intent: EmailOtpStartIntent,
  context: VaultContext | undefined,
): EmailOtpPurpose | undefined {
  if (intent === 'sign-in') return { kind: 'sign-in' };
  return context ? { kind: 'link', accountId: context.accountId } : undefined;
}

async function invalidateAfterDeliveryFailure(
  challenges: EmailOtpChallengeStore,
  challenge: PendingEmailOtpChallenge,
  nowEpochSeconds: number,
): Promise<void> {
  const invalidated = invalidateEmailOtpDelivery(challenge, nowEpochSeconds);
  if (invalidated === undefined) return;
  await challenges.compareAndSwap(
    challenge.challengeId,
    challenge.version,
    invalidated,
  );
}

function decodeEpoch(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
    ? input
    : undefined;
}

function authenticationUnavailable(): EmailOtpStartResult {
  return { kind: 'failed', error: 'authentication-unavailable' };
}

function verificationFailed(): EmailOtpCompletionResult {
  return { kind: 'failed', error: 'verification-failed' };
}
