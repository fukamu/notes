import { describe, expect, it } from 'vitest';
import {
  emailOtpAddressDecoder,
  emailOtpChallengeIdDecoder,
  emailOtpCodeDecoder,
  emailOtpDigestDecoder,
} from '@/lib/domain/email-otp';
import {
  EMAIL_OTP_MAX_FAILED_ATTEMPTS,
  EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS,
  EMAIL_OTP_RESEND_INTERVAL_SECONDS,
  EMAIL_OTP_TTL_SECONDS,
  createEmailOtpChallenge,
  decideEmailOtpIdentityResolution,
  emailOtpChallengeDecoder,
  invalidateEmailOtpDelivery,
  reserveEmailOtpRateLimit,
  resendEmailOtpChallenge,
  verifyEmailOtpChallenge,
  type EmailOtpChallenge,
  type EmailOtpRateLimitState,
} from '@/server/core/email-otp';
import {
  emailOtpFixture,
  emailOtpIdentityRecord,
  fixturePendingEmailOtp,
} from '@/tests/fixtures/email-otp';
import { sessionFixtureIds } from '@/tests/fixtures/session';

describe('Email OTP boundary codecs', () => {
  it('normalizes bounded ASCII addresses and accepts only eight digits', () => {
    const address = emailOtpAddressDecoder.decode('Person@Example.COM');
    expect(address).toEqual({ ok: true, value: 'Person@example.com' });
    expect(emailOtpAddressDecoder.decode('person..x@example.com').ok).toBe(
      false,
    );
    expect(emailOtpAddressDecoder.decode('person@example.com ').ok).toBe(false);
    expect(emailOtpCodeDecoder.decode('12345678').ok).toBe(true);
    for (const candidate of ['1234567', '123456789', '1234abcd']) {
      expect(emailOtpCodeDecoder.decode(candidate).ok).toBe(false);
    }
    expect(emailOtpChallengeIdDecoder.decode('not-a-uuid').ok).toBe(false);
    expect(emailOtpDigestDecoder.decode(`${'A'.repeat(42)}B`).ok).toBe(false);
  });

  it('rejects malformed persisted challenge timelines and unknown fields', () => {
    expect(emailOtpChallengeDecoder.decode(fixturePendingEmailOtp()).ok).toBe(
      true,
    );
    expect(
      emailOtpChallengeDecoder.decode({
        ...fixturePendingEmailOtp(),
        plaintextCode: emailOtpFixture.code,
      }).ok,
    ).toBe(false);
    expect(
      emailOtpChallengeDecoder.decode(
        fixturePendingEmailOtp({ expiresAtEpochSeconds: 1_601 }),
      ).ok,
    ).toBe(false);
    expect(
      emailOtpChallengeDecoder.decode(
        fixturePendingEmailOtp({ failedAttempts: 5 }),
      ).ok,
    ).toBe(false);
    expect(
      emailOtpChallengeDecoder.decode(
        fixturePendingEmailOtp({ failedAttempts: 1, version: 1 }),
      ).ok,
    ).toBe(false);
  });
});

describe('Email OTP challenge policy', () => {
  it('creates a ten-minute, single-purpose challenge without plaintext code', () => {
    const decision = createEmailOtpChallenge({
      challengeId: emailOtpFixture.challengeId,
      address: emailOtpFixture.address,
      digest: emailOtpFixture.digest,
      salt: emailOtpFixture.salt,
      purpose: { kind: 'sign-in' },
      nowEpochSeconds: 1_000,
    });
    expect(decision.kind).toBe('created');
    if (decision.kind !== 'created') return;
    expect(decision.challenge.expiresAtEpochSeconds).toBe(
      1_000 + EMAIL_OTP_TTL_SECONDS,
    );
    expect(JSON.stringify(decision.challenge)).not.toContain(
      emailOtpFixture.code,
    );
    expect(
      createEmailOtpChallenge({
        challengeId: emailOtpFixture.challengeId,
        address: emailOtpFixture.address,
        digest: emailOtpFixture.digest,
        salt: emailOtpFixture.salt,
        purpose: { kind: 'sign-in' },
        nowEpochSeconds: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-clock' });
  });

  it('consumes a correct code once and invalidates an expired challenge', () => {
    const challenge = fixturePendingEmailOtp();
    const verified = verifyEmailOtpChallenge({
      challenge,
      digestMatches: true,
      nowEpochSeconds: 1_500,
    });
    expect(verified.kind).toBe('verified');
    if (verified.kind !== 'verified') return;
    expect(verified.challenge.kind).toBe('consumed');
    expect(
      verifyEmailOtpChallenge({
        challenge: verified.challenge,
        digestMatches: true,
        nowEpochSeconds: 1_501,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-pending' });

    const expired = verifyEmailOtpChallenge({
      challenge,
      digestMatches: true,
      nowEpochSeconds: 1_600,
    });
    expect(expired).toMatchObject({
      kind: 'rejected',
      reason: 'expired',
      challenge: { kind: 'invalidated', reason: 'expired' },
    });
  });

  it('locks after five failures and never grants a sixth attempt', () => {
    let challenge: EmailOtpChallenge = fixturePendingEmailOtp();
    for (
      let attempt = 1;
      attempt <= EMAIL_OTP_MAX_FAILED_ATTEMPTS;
      attempt += 1
    ) {
      const decision = verifyEmailOtpChallenge({
        challenge,
        digestMatches: false,
        nowEpochSeconds: 1_000 + attempt,
      });
      expect(decision.kind).toBe('rejected');
      expect(decision.challenge?.failedAttempts).toBe(attempt);
      if (decision.challenge) challenge = decision.challenge;
    }
    expect(challenge.kind).toBe('locked');
    expect(
      verifyEmailOtpChallenge({
        challenge,
        digestMatches: true,
        nowEpochSeconds: 1_100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-pending' });
  });

  it('enforces resend cooldown and send cap without resetting failures or expiry', () => {
    const challenge = fixturePendingEmailOtp({ failedAttempts: 2 });
    expect(
      resendEmailOtpChallenge({
        challenge,
        digest: emailOtpFixture.digest,
        salt: emailOtpFixture.otherSalt,
        nowEpochSeconds: 1_000 + EMAIL_OTP_RESEND_INTERVAL_SECONDS - 1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'too-soon' });
    const resent = resendEmailOtpChallenge({
      challenge,
      digest: emailOtpFixture.digest,
      salt: emailOtpFixture.otherSalt,
      nowEpochSeconds: 1_000 + EMAIL_OTP_RESEND_INTERVAL_SECONDS,
    });
    expect(resent).toMatchObject({
      kind: 'resent',
      challenge: {
        failedAttempts: 2,
        sendCount: 2,
        expiresAtEpochSeconds: 1_600,
      },
    });
    expect(
      resendEmailOtpChallenge({
        challenge: fixturePendingEmailOtp({
          sendCount: 3,
          lastSentAtEpochSeconds: 1_100,
        }),
        digest: emailOtpFixture.digest,
        salt: emailOtpFixture.otherSalt,
        nowEpochSeconds: 1_200,
      }),
    ).toEqual({ kind: 'rejected', reason: 'send-limit' });
  });

  it('invalidates a persisted challenge when delivery fails', () => {
    expect(
      invalidateEmailOtpDelivery(fixturePendingEmailOtp(), 1_001),
    ).toMatchObject({
      kind: 'invalidated',
      reason: 'delivery-failed',
      version: 2,
    });
  });
});

describe('Email OTP abuse and identity policy', () => {
  function rateState(counts: {
    readonly address: number;
    readonly network: number;
    readonly account?: number;
  }): EmailOtpRateLimitState {
    const bucket = (key: typeof emailOtpFixture.addressKey, count: number) => ({
      key,
      count,
      windowStartedAtEpochSeconds: 1_000,
    });
    return {
      address: bucket(emailOtpFixture.addressKey, counts.address),
      network: bucket(emailOtpFixture.networkKey, counts.network),
      ...(counts.account === undefined
        ? {}
        : { account: bucket(emailOtpFixture.accountKey, counts.account) }),
    };
  }

  it('reserves all abuse dimensions atomically and resets only after the window', () => {
    expect(
      reserveEmailOtpRateLimit(rateState({ address: 4, network: 4 }), 1_100),
    ).toMatchObject({
      kind: 'reserved',
      state: { address: { count: 5 }, network: { count: 5 } },
    });
    expect(
      reserveEmailOtpRateLimit(rateState({ address: 5, network: 1 }), 1_100),
    ).toEqual({ kind: 'rejected', reason: 'limited' });
    expect(
      reserveEmailOtpRateLimit(
        rateState({ address: 5, network: 30, account: 5 }),
        1_000 + EMAIL_OTP_RATE_LIMIT_WINDOW_SECONDS,
      ),
    ).toMatchObject({
      kind: 'reserved',
      state: {
        address: { count: 1 },
        network: { count: 1 },
        account: { count: 1 },
      },
    });
    expect(
      reserveEmailOtpRateLimit(
        {
          ...rateState({ address: 0, network: 0 }),
          address: {
            ...rateState({ address: 0, network: 0 }).address,
            windowStartedAtEpochSeconds: 1_001,
          },
        },
        1_000,
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-clock' });
  });

  it('never auto-links a Google/contact-email collision', () => {
    expect(
      decideEmailOtpIdentityResolution({
        purpose: { kind: 'sign-in' },
        address: emailOtpFixture.address,
        verifiedContactAccountId: sessionFixtureIds.accountId,
      }),
    ).toEqual({ kind: 'rejected', reason: 'email-collision' });
    expect(
      decideEmailOtpIdentityResolution({
        purpose: { kind: 'sign-in' },
        address: emailOtpFixture.address,
        existingIdentity: emailOtpIdentityRecord,
      }),
    ).toEqual({
      kind: 'authenticate-existing',
      identity: emailOtpIdentityRecord,
    });
    expect(
      decideEmailOtpIdentityResolution({
        purpose: { kind: 'link', accountId: sessionFixtureIds.otherAccountId },
        address: emailOtpFixture.address,
        existingIdentity: emailOtpIdentityRecord,
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'identity-owned-by-another-account',
    });
  });
});
