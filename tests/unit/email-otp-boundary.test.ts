import { describe, expect, it, vi } from 'vitest';
import {
  createFakeEmailDelivery,
  createFakeEmailOtpAbuseKeys,
  createFakeEmailOtpChallengeStore,
  createFakeEmailOtpHasher,
  createFakeEmailOtpIdentityDirectory,
  createFakeEmailOtpRateLimits,
  createFakeEmailOtpSecrets,
} from '@/server/adapters/fake-email-otp';
import {
  completeEmailOtp,
  resendEmailOtp,
  startEmailOtp,
  type EmailOtpChallengeStore,
  type EmailOtpHasherPort,
} from '@/server/email-otp-boundary';
import {
  emailOtpFixture,
  emailOtpIdentityRecord,
} from '@/tests/fixtures/email-otp';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const rateLimitKeys = {
  address: emailOtpFixture.addressKey,
  network: emailOtpFixture.networkKey,
} as const;

function runtime(
  input: {
    readonly challengeIds?: readonly unknown[];
    readonly codes?: readonly unknown[];
    readonly salts?: readonly unknown[];
    readonly now?: number;
    readonly includeAccountKey?: boolean;
  } = {},
) {
  let now = input.now ?? 1_000;
  const challenges = createFakeEmailOtpChallengeStore();
  const delivery = createFakeEmailDelivery();
  return {
    clock: { nowEpochSeconds: () => now },
    setNow(value: number) {
      now = value;
    },
    secrets: createFakeEmailOtpSecrets({
      challengeIds: input.challengeIds ?? [emailOtpFixture.challengeId],
      codes: input.codes ?? [emailOtpFixture.code],
      salts: input.salts ?? [emailOtpFixture.salt],
    }),
    hasher: createFakeEmailOtpHasher(),
    challenges,
    abuseKeys: createFakeEmailOtpAbuseKeys({
      ...rateLimitKeys,
      ...(input.includeAccountKey === false
        ? {}
        : { account: emailOtpFixture.accountKey }),
    }),
    rateLimits: createFakeEmailOtpRateLimits(),
    delivery,
  };
}

describe('Email OTP start boundary', () => {
  it('stores only a salted digest while sending the ephemeral code', async () => {
    const ports = runtime();
    await expect(
      startEmailOtp({
        address: 'Person@Example.com',
        intent: 'sign-in',
        networkContext: { remoteAddress: 'test-network' },
        ...ports,
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      challengeId: emailOtpFixture.challengeId,
    });
    expect(ports.delivery.messages()).toEqual([
      {
        challengeId: emailOtpFixture.challengeId,
        address: emailOtpFixture.address,
        code: emailOtpFixture.code,
        expiresAtEpochSeconds: 1_600,
      },
    ]);
    const persisted = JSON.stringify(ports.challenges.records());
    expect(persisted).not.toContain(emailOtpFixture.code);
    expect(persisted).toContain('digest');
    expect(ports.rateLimits.count('address', rateLimitKeys.address)).toBe(1);
  });

  it('uses the same accepted shape for invalid addresses and rate limits', async () => {
    const invalid = runtime();
    const invalidResult = await startEmailOtp({
      address: 'not-an-address',
      intent: 'sign-in',
      networkContext: { remoteAddress: 'test-network' },
      ...invalid,
    });
    const limited = runtime();
    for (let reservation = 0; reservation < 5; reservation += 1) {
      await limited.rateLimits.reserve(rateLimitKeys, 1_000);
    }
    const limitedResult = await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'sign-in',
      networkContext: { remoteAddress: 'test-network' },
      ...limited,
    });
    expect(invalidResult).toEqual(limitedResult);
    expect(invalid.delivery.messages()).toHaveLength(0);
    expect(limited.delivery.messages()).toHaveLength(0);
    expect(invalid.challenges.records()).toHaveLength(0);
    expect(limited.challenges.records()).toHaveLength(0);
  });

  it('invalidates a challenge when fake delivery fails without exposing failure', async () => {
    const ports = runtime();
    const delivery = createFakeEmailDelivery({ fail: () => true });
    await expect(
      startEmailOtp({
        address: emailOtpFixture.address,
        intent: 'sign-in',
        networkContext: { remoteAddress: 'test-network' },
        ...ports,
        delivery,
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      challengeId: emailOtpFixture.challengeId,
    });
    expect(ports.challenges.records()).toMatchObject([
      { kind: 'invalidated', reason: 'delivery-failed' },
    ]);
  });

  it('keeps the accepted public shape when persistence is unavailable', async () => {
    const ports = runtime();
    const challenges: EmailOtpChallengeStore = {
      ...ports.challenges,
      insertPending: vi.fn(async () => {
        throw new Error('fake unavailable store');
      }),
    };
    await expect(
      startEmailOtp({
        address: emailOtpFixture.address,
        intent: 'sign-in',
        networkContext: { remoteAddress: 'test-network' },
        ...ports,
        challenges,
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      challengeId: emailOtpFixture.challengeId,
    });
    expect(ports.delivery.messages()).toHaveLength(0);
  });

  it('derives link ownership only from VaultContext and requires its abuse key', async () => {
    const vaultContext = {
      accountId: sessionFixtureIds.accountId,
      vaultId: sessionFixtureIds.vaultId,
      sessionId: sessionFixtureIds.sessionId,
      sessionEpoch: sessionFixtureIds.epoch,
    } as const;
    const missingContext = runtime();
    await expect(
      startEmailOtp({
        address: emailOtpFixture.address,
        intent: 'link-current-account',
        networkContext: { remoteAddress: 'test-network' },
        ...missingContext,
      }),
    ).resolves.toMatchObject({ kind: 'accepted' });
    expect(missingContext.delivery.messages()).toHaveLength(0);

    const missingAccountKey = runtime({ includeAccountKey: false });
    await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'link-current-account',
      vaultContext,
      networkContext: { remoteAddress: 'test-network' },
      ...missingAccountKey,
    });
    expect(missingAccountKey.delivery.messages()).toHaveLength(0);

    const linked = runtime();
    await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'link-current-account',
      vaultContext,
      networkContext: { remoteAddress: 'test-network' },
      ...linked,
    });
    expect(linked.challenges.records()[0]).toMatchObject({
      purpose: { kind: 'link', accountId: sessionFixtureIds.accountId },
    });
  });
});

describe('Email OTP completion boundary', () => {
  async function start(ports: ReturnType<typeof runtime>): Promise<void> {
    const result = await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'sign-in',
      networkContext: { remoteAddress: 'test-network' },
      ...ports,
    });
    expect(result.kind).toBe('accepted');
  }

  it('authenticates once and rejects replay with the same generic error', async () => {
    const ports = runtime();
    await start(ports);
    const input = {
      challengeId: emailOtpFixture.challengeId,
      code: emailOtpFixture.code,
      clock: ports.clock,
      hasher: ports.hasher,
      challenges: ports.challenges,
      identities: createFakeEmailOtpIdentityDirectory({
        identities: [emailOtpIdentityRecord],
      }),
    } as const;
    await expect(completeEmailOtp(input)).resolves.toEqual({
      kind: 'resolved',
      resolution: {
        kind: 'authenticate-existing',
        identity: emailOtpIdentityRecord,
      },
    });
    await expect(completeEmailOtp(input)).resolves.toEqual({
      kind: 'failed',
      error: 'verification-failed',
    });
    expect(ports.challenges.records()).toMatchObject([{ kind: 'consumed' }]);
  });

  it('allows exactly one winner when two completions race on the same version', async () => {
    const ports = runtime();
    await start(ports);
    const input = {
      challengeId: emailOtpFixture.challengeId,
      code: emailOtpFixture.code,
      clock: ports.clock,
      hasher: ports.hasher,
      challenges: ports.challenges,
      identities: createFakeEmailOtpIdentityDirectory({
        identities: [emailOtpIdentityRecord],
      }),
    } as const;
    const results = await Promise.all([
      completeEmailOtp(input),
      completeEmailOtp(input),
    ]);
    expect(results.filter((result) => result.kind === 'resolved')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === 'failed')).toHaveLength(
      1,
    );
  });

  it('persists failed attempts and locks the challenge after five tries', async () => {
    const ports = runtime();
    await start(ports);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        completeEmailOtp({
          challengeId: emailOtpFixture.challengeId,
          code: emailOtpFixture.otherCode,
          clock: ports.clock,
          hasher: ports.hasher,
          challenges: ports.challenges,
          identities: createFakeEmailOtpIdentityDirectory(),
        }),
      ).resolves.toEqual({
        kind: 'failed',
        error: 'verification-failed',
      });
    }
    expect(ports.challenges.records()).toMatchObject([
      { kind: 'locked', failedAttempts: 5 },
    ]);
  });

  it('does not expose identity collisions and consumes the verified challenge', async () => {
    const ports = runtime();
    await start(ports);
    await expect(
      completeEmailOtp({
        challengeId: emailOtpFixture.challengeId,
        code: emailOtpFixture.code,
        clock: ports.clock,
        hasher: ports.hasher,
        challenges: ports.challenges,
        identities: createFakeEmailOtpIdentityDirectory({
          verifiedContacts: new Map([
            [emailOtpFixture.address, sessionFixtureIds.accountId],
          ]),
        }),
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'verification-failed',
    });
    expect(ports.challenges.records()).toMatchObject([{ kind: 'consumed' }]);
  });

  it('fails closed on malformed hasher and store values', async () => {
    const ports = runtime();
    await start(ports);
    const malformedHasher: EmailOtpHasherPort = {
      createDigest: ports.hasher.createDigest,
      matchesDigest: vi.fn(async () => 'true'),
    };
    await expect(
      completeEmailOtp({
        challengeId: emailOtpFixture.challengeId,
        code: emailOtpFixture.code,
        clock: ports.clock,
        hasher: malformedHasher,
        challenges: ports.challenges,
        identities: createFakeEmailOtpIdentityDirectory(),
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'verification-failed',
    });
    expect(ports.challenges.records()).toMatchObject([{ kind: 'pending' }]);

    const malformedStore: EmailOtpChallengeStore = {
      insertPending: vi.fn(async () => undefined),
      findById: vi.fn(async () => ({ plaintextCode: emailOtpFixture.code })),
      compareAndSwap: vi.fn(async () => true),
    };
    await expect(
      completeEmailOtp({
        challengeId: emailOtpFixture.challengeId,
        code: emailOtpFixture.code,
        clock: ports.clock,
        hasher: ports.hasher,
        challenges: malformedStore,
        identities: createFakeEmailOtpIdentityDirectory(),
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'verification-failed',
    });
  });
});

describe('Email OTP resend boundary', () => {
  it('rotates the code after cooldown without resetting failed attempts', async () => {
    const ports = runtime({
      codes: [emailOtpFixture.code, emailOtpFixture.otherCode],
      salts: [emailOtpFixture.salt, emailOtpFixture.otherSalt],
    });
    await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'sign-in',
      networkContext: { remoteAddress: 'test-network' },
      ...ports,
    });
    await completeEmailOtp({
      challengeId: emailOtpFixture.challengeId,
      code: '00000000',
      clock: ports.clock,
      hasher: ports.hasher,
      challenges: ports.challenges,
      identities: createFakeEmailOtpIdentityDirectory(),
    });
    ports.setNow(1_060);
    await expect(
      resendEmailOtp({
        challengeId: emailOtpFixture.challengeId,
        networkContext: { remoteAddress: 'test-network' },
        clock: ports.clock,
        secrets: ports.secrets,
        hasher: ports.hasher,
        challenges: ports.challenges,
        abuseKeys: ports.abuseKeys,
        rateLimits: ports.rateLimits,
        delivery: ports.delivery,
      }),
    ).resolves.toEqual({ kind: 'accepted' });
    expect(ports.challenges.records()).toMatchObject([
      { kind: 'pending', failedAttempts: 1, sendCount: 2, version: 3 },
    ]);
    expect(ports.delivery.messages().map((message) => message.code)).toEqual([
      emailOtpFixture.code,
      emailOtpFixture.otherCode,
    ]);
  });
});
