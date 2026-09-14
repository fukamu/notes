import type {
  TermsConsentId,
  TermsConsentSubmissionId,
} from '../terms-consent/public';
import type {
  SignupAdmissionReceipt,
  SignupAdmissionReservation,
  VerifiedSignupIdentity,
} from './public';

export type CurrentSignupTermsEvidence = Readonly<{
  submissionId: TermsConsentSubmissionId;
  accountId: SignupAdmissionReservation['accountId'];
  vaultId: SignupAdmissionReservation['vaultId'];
  consentId: TermsConsentId;
}>;

export type SignupAdmissionPlan =
  | {
      readonly kind: 'ready';
      readonly reservation: SignupAdmissionReservation;
      readonly consentId: TermsConsentId;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'identity-mismatch'
        | 'submission-mismatch'
        | 'owner-mismatch';
    };

export function planSignupAdmission(input: {
  readonly identity: VerifiedSignupIdentity;
  readonly submissionId: TermsConsentSubmissionId;
  readonly reservation: SignupAdmissionReservation;
  readonly evidence: CurrentSignupTermsEvidence;
}): SignupAdmissionPlan {
  if (!sameIdentity(input.identity, input.reservation.identity)) {
    return { kind: 'rejected', reason: 'identity-mismatch' };
  }
  if (
    input.reservation.submissionId !== input.submissionId ||
    input.evidence.submissionId !== input.submissionId
  ) {
    return { kind: 'rejected', reason: 'submission-mismatch' };
  }
  if (
    input.reservation.accountId !== input.evidence.accountId ||
    input.reservation.vaultId !== input.evidence.vaultId
  ) {
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  return {
    kind: 'ready',
    reservation: input.reservation,
    consentId: input.evidence.consentId,
  };
}

export function signupReceiptMatchesPlan(
  receipt: SignupAdmissionReceipt,
  plan: Extract<SignupAdmissionPlan, { readonly kind: 'ready' }>,
): boolean {
  const reservation = plan.reservation;
  return (
    receipt.submissionId === reservation.submissionId &&
    sameIdentity(receipt.identity, reservation.identity) &&
    receipt.accountId === reservation.accountId &&
    receipt.vaultId === reservation.vaultId &&
    receipt.identityId === reservation.identityId &&
    receipt.sessionId === reservation.sessionId &&
    receipt.sessionEpoch === reservation.sessionEpoch &&
    receipt.termsConsentId === plan.consentId
  );
}

function sameIdentity(
  left: VerifiedSignupIdentity,
  right: VerifiedSignupIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'google':
      return (
        right.kind === 'google' &&
        left.issuer === right.issuer &&
        left.subject === right.subject &&
        left.email === right.email
      );
    case 'email-otp':
      return right.kind === 'email-otp' && left.address === right.address;
  }
}
