import { describe, expect, it } from 'vitest';
import {
  planSignupAdmission,
  signupReceiptMatchesPlan,
} from '@/server/signup-admission/core';
import {
  signupAdmissionReceiptDecoder,
  type SignupAdmissionReservation,
  type VerifiedSignupIdentity,
} from '@/server/signup-admission/public';
import { emailOtpFixture } from '@/tests/fixtures/email-otp';
import { oidcFixture } from '@/tests/fixtures/oidc';
import { sessionFixtureIds } from '@/tests/fixtures/session';
import { termsConsentIds } from '@/tests/fixtures/terms-consent';

const googleIdentity: VerifiedSignupIdentity = {
  kind: 'google',
  issuer: oidcFixture.issuer,
  subject: oidcFixture.subject,
  email: oidcFixture.email,
};

function reservation(
  overrides: Partial<SignupAdmissionReservation> = {},
): SignupAdmissionReservation {
  return {
    submissionId: termsConsentIds.submissionA,
    identity: googleIdentity,
    accountId: sessionFixtureIds.accountId,
    vaultId: sessionFixtureIds.vaultId,
    identityId: sessionFixtureIds.identityId,
    sessionId: sessionFixtureIds.sessionId,
    sessionEpoch: sessionFixtureIds.epoch,
    ...overrides,
  };
}

function evidence() {
  return {
    submissionId: termsConsentIds.submissionA,
    accountId: sessionFixtureIds.accountId,
    vaultId: sessionFixtureIds.vaultId,
    consentId: termsConsentIds.consentA,
  } as const;
}

describe('signup admission pure policy', () => {
  it('binds verified identity, submission, tenant scope, consent, and initial session', () => {
    const planned = planSignupAdmission({
      identity: googleIdentity,
      submissionId: termsConsentIds.submissionA,
      reservation: reservation(),
      evidence: evidence(),
    });
    expect(planned).toMatchObject({
      kind: 'ready',
      consentId: termsConsentIds.consentA,
    });
    if (planned.kind !== 'ready') return;
    const receipt = {
      ...planned.reservation,
      termsConsentId: planned.consentId,
    };
    expect(signupReceiptMatchesPlan(receipt, planned)).toBe(true);
    expect(
      signupReceiptMatchesPlan(
        { ...receipt, sessionId: sessionFixtureIds.nextSessionId },
        planned,
      ),
    ).toBe(false);
    expect(
      signupAdmissionReceiptDecoder.decode({
        ...receipt,
        sessionEpoch: sessionFixtureIds.nextEpoch,
      }).ok,
    ).toBe(false);
  });

  it('rejects identity, submission, and tenant-scope substitution', () => {
    const emailIdentity: VerifiedSignupIdentity = {
      kind: 'email-otp',
      address: emailOtpFixture.address,
    };
    expect(
      planSignupAdmission({
        identity: emailIdentity,
        submissionId: termsConsentIds.submissionA,
        reservation: reservation(),
        evidence: evidence(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'identity-mismatch' });
    expect(
      planSignupAdmission({
        identity: googleIdentity,
        submissionId: termsConsentIds.submissionB,
        reservation: reservation(),
        evidence: evidence(),
      }),
    ).toEqual({ kind: 'rejected', reason: 'submission-mismatch' });
    expect(
      planSignupAdmission({
        identity: googleIdentity,
        submissionId: termsConsentIds.submissionA,
        reservation: reservation(),
        evidence: {
          ...evidence(),
          vaultId: sessionFixtureIds.otherVaultId,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
  });
});
