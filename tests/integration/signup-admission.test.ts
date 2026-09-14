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
  createFakeOidcIdentityDirectory,
  createFakeOidcProvider,
  createFakeOidcSecrets,
  createFakeOidcTransactionStore,
} from '@/server/adapters/fake-oidc';
import { webCryptoPkce } from '@/server/adapters/web-oidc';
import { completeEmailOtp, startEmailOtp } from '@/server/email-otp-boundary';
import { completeGoogleOidc, startGoogleOidc } from '@/server/oidc-boundary';
import { createSignupAdmissionApplication } from '@/server/signup-admission/application';
import {
  createFakeSignupAdmissionIds,
  createFakeSignupProvisioning,
  type FakeSignupProvisioning,
} from '@/server/signup-admission/fake';
import type {
  SignupAdmissionPort,
  SignupProvisioningPort,
  VerifiedSignupIdentity,
} from '@/server/signup-admission/public';
import type { TermsConsentApplication } from '@/server/terms-consent/application';
import { createFakeTermsConsentModule } from '@/server/terms-consent/fake';
import { emailOtpFixture } from '@/tests/fixtures/email-otp';
import {
  fixtureOidcClaims,
  oidcConfiguration,
  oidcFixture,
} from '@/tests/fixtures/oidc';
import { sessionFixtureIds } from '@/tests/fixtures/session';
import {
  termsConsentCommand,
  termsConsentIds,
} from '@/tests/fixtures/terms-consent';

const clock = { nowEpochSeconds: () => 2_000 } as const;
const allocation = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  identityId: sessionFixtureIds.identityId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
} as const;

function admission(
  input: {
    readonly terms?: Pick<TermsConsentApplication, 'accept'>;
    readonly provisioning?: SignupProvisioningPort;
    readonly consentIds?: readonly (typeof termsConsentIds.consentA)[];
  } = {},
): {
  readonly application: SignupAdmissionPort;
  readonly provisioning: SignupProvisioningPort;
  readonly fakeProvisioning: FakeSignupProvisioning | undefined;
} {
  const terms = createFakeTermsConsentModule();
  const fakeProvisioning =
    input.provisioning === undefined
      ? createFakeSignupProvisioning([allocation])
      : undefined;
  const provisioning = input.provisioning ?? fakeProvisioning;
  if (provisioning === undefined) {
    throw new Error('signup provisioning fixture is unavailable');
  }
  return {
    provisioning,
    fakeProvisioning,
    application: createSignupAdmissionApplication({
      clock,
      ids: createFakeSignupAdmissionIds(
        input.consentIds ?? [
          termsConsentIds.consentA,
          termsConsentIds.consentB,
        ],
      ),
      provisioning,
      terms: input.terms ?? terms.application,
    }),
  };
}

describe('provider-neutral signup terms admission', () => {
  it('admits a Google verified identity only through persisted current consent', async () => {
    const transactions = createFakeOidcTransactionStore();
    await expect(
      startGoogleOidc({
        configuration: oidcConfiguration,
        redirectUri: oidcFixture.redirectUri,
        intent: 'sign-in',
        signupTermsConsent: termsConsentCommand(),
        clock,
        secrets: createFakeOidcSecrets({
          state: oidcFixture.state,
          nonce: oidcFixture.nonce,
          codeVerifier: oidcFixture.verifier,
        }),
        pkce: webCryptoPkce,
        transactions,
      }),
    ).resolves.toMatchObject({ kind: 'redirect' });
    const signup = admission();
    await expect(
      completeGoogleOidc({
        callback: { state: oidcFixture.state, code: oidcFixture.code },
        configuration: oidcConfiguration,
        clock,
        transactions,
        provider: createFakeOidcProvider(
          new Map([[oidcFixture.code, fixtureOidcClaims({ exp: 3_000 })]]),
        ),
        identities: createFakeOidcIdentityDirectory(),
        signupAdmission: signup.application,
      }),
    ).resolves.toMatchObject({
      kind: 'admitted',
      admission: {
        identity: {
          kind: 'google',
          issuer: oidcFixture.issuer,
          subject: oidcFixture.subject,
        },
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionEpoch: 1,
        termsConsentId: termsConsentIds.consentA,
      },
    });
    expect(signup.fakeProvisioning?.finalizationCount()).toBe(1);
  });

  it('uses the same admission application after one-time Email OTP verification', async () => {
    const challenges = createFakeEmailOtpChallengeStore();
    const signup = admission();
    await startEmailOtp({
      address: emailOtpFixture.address,
      intent: 'sign-in',
      signupTermsConsent: termsConsentCommand(),
      networkContext: { remoteAddress: 'test' },
      clock,
      secrets: createFakeEmailOtpSecrets({
        challengeIds: [emailOtpFixture.challengeId],
        codes: [emailOtpFixture.code],
        salts: [emailOtpFixture.salt],
      }),
      hasher: createFakeEmailOtpHasher(),
      challenges,
      abuseKeys: createFakeEmailOtpAbuseKeys({
        address: emailOtpFixture.addressKey,
        network: emailOtpFixture.networkKey,
      }),
      rateLimits: createFakeEmailOtpRateLimits(),
      delivery: createFakeEmailDelivery(),
    });
    await expect(
      completeEmailOtp({
        challengeId: emailOtpFixture.challengeId,
        code: emailOtpFixture.code,
        clock,
        hasher: createFakeEmailOtpHasher(),
        challenges,
        identities: createFakeEmailOtpIdentityDirectory(),
        signupAdmission: signup.application,
      }),
    ).resolves.toMatchObject({
      kind: 'admitted',
      admission: {
        identity: { kind: 'email-otp', address: emailOtpFixture.address },
        sessionEpoch: 1,
        termsConsentId: termsConsentIds.consentA,
      },
    });
    expect(signup.fakeProvisioning?.finalizationCount()).toBe(1);
  });

  it('fails closed for missing or stale consent before finalization', async () => {
    const identity: VerifiedSignupIdentity = {
      kind: 'google',
      issuer: oidcFixture.issuer,
      subject: oidcFixture.subject,
      email: oidcFixture.email,
    };
    const missing = admission();
    await expect(
      missing.application.admit({
        identity,
        termsConsent: {
          ...termsConsentCommand(),
          consent: { kind: 'not-affirmed' },
        },
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'terms-consent-required',
    });
    expect(missing.fakeProvisioning?.reservations()).toHaveLength(0);

    const stale = admission();
    await expect(
      stale.application.admit({
        identity,
        termsConsent: termsConsentCommand({
          presentedTermsHash: termsConsentIds.hashB,
        }),
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'terms-changed' });
    expect(stale.fakeProvisioning?.finalizationCount()).toBe(0);
  });

  it('rejects cross-tenant evidence and never finalizes it', async () => {
    const provisioning = createFakeSignupProvisioning([allocation]);
    const signup = admission({
      provisioning,
      terms: {
        accept: vi.fn(
          async () =>
            ({
              kind: 'rejected',
              reason: 'owner-mismatch',
            }) as const,
        ),
      },
    });
    await expect(
      signup.application.admit({
        identity: {
          kind: 'email-otp',
          address: emailOtpFixture.address,
        },
        termsConsent: termsConsentCommand(),
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    expect(provisioning.finalizationCount()).toBe(0);
  });

  it('replays one admission without duplicating Account, Vault, identity, or session', async () => {
    const signup = admission();
    const input = {
      identity: {
        kind: 'email-otp',
        address: emailOtpFixture.address,
      } as const,
      termsConsent: termsConsentCommand(),
    };
    await expect(signup.application.admit(input)).resolves.toMatchObject({
      kind: 'admitted',
      outcome: 'created',
    });
    await expect(signup.application.admit(input)).resolves.toMatchObject({
      kind: 'admitted',
      outcome: 'replayed',
    });
    const provisioning = signup.fakeProvisioning;
    if (provisioning === undefined) {
      throw new Error('expected fake signup provisioning');
    }
    expect(provisioning.reservations()).toHaveLength(1);
    expect(provisioning.receipts()).toHaveLength(1);
    expect(provisioning.finalizationCount()).toBe(1);
  });

  it('rejects malformed server allocation before consent or session finalization', async () => {
    const finalize = vi.fn(async () => ({ kind: 'conflict' }));
    const identity: VerifiedSignupIdentity = {
      kind: 'email-otp',
      address: emailOtpFixture.address,
    };
    const signup = admission({
      provisioning: {
        reserve: vi.fn(async () => ({
          kind: 'reserved',
          reservation: {
            submissionId: termsConsentIds.submissionA,
            identity,
            ...allocation,
            sessionEpoch: 2,
          },
        })),
        finalize,
      },
    });
    await expect(
      signup.application.admit({
        identity,
        termsConsent: termsConsentCommand(),
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
    expect(finalize).not.toHaveBeenCalled();
  });
});
