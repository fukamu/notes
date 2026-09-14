import {
  termsConsentCommandDecoder,
  termsConsentIdDecoder,
} from '../terms-consent/public';
import type { TermsConsentApplication } from '../terms-consent/application';
import { planSignupAdmission, signupReceiptMatchesPlan } from './core';
import {
  signupAdmissionReceiptDecoder,
  signupFinalizationResultDecoder,
  signupReservationResultDecoder,
  verifiedSignupIdentityDecoder,
  type SignupAdmissionPort,
  type SignupAdmissionResult,
  type SignupProvisioningPort,
} from './public';

export type SignupAdmissionClockPort = {
  nowEpochSeconds(): unknown;
};

export type SignupAdmissionIdPort = {
  createTermsConsentId(): Promise<unknown>;
};

export function createSignupAdmissionApplication(dependencies: {
  readonly clock: SignupAdmissionClockPort;
  readonly ids: SignupAdmissionIdPort;
  readonly provisioning: SignupProvisioningPort;
  readonly terms: Pick<TermsConsentApplication, 'accept'>;
}): SignupAdmissionPort {
  return {
    async admit(input): Promise<SignupAdmissionResult> {
      const identity = verifiedSignupIdentityDecoder.decode(input.identity);
      const command = termsConsentCommandDecoder.decode(input.termsConsent);
      if (!identity.ok) return rejected('unavailable');
      if (!command.ok || command.value.consent.kind !== 'affirmed') {
        return rejected('terms-consent-required');
      }

      let reservedCandidate: unknown;
      try {
        reservedCandidate = await dependencies.provisioning.reserve({
          submissionId: command.value.submissionId,
          identity: identity.value,
        });
      } catch {
        return rejected('unavailable');
      }
      const reserved = signupReservationResultDecoder.decode(reservedCandidate);
      if (!reserved.ok) return rejected('unavailable');
      if (reserved.value.kind === 'conflict') {
        return rejected('provisioning-conflict');
      }

      const now = dependencies.clock.nowEpochSeconds();
      if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
        return rejected('unavailable');
      }
      let consentIdCandidate: unknown;
      try {
        consentIdCandidate = await dependencies.ids.createTermsConsentId();
      } catch {
        return rejected('unavailable');
      }
      const consentId = termsConsentIdDecoder.decode(consentIdCandidate);
      if (!consentId.ok) return rejected('unavailable');

      const reservation = reserved.value.reservation;
      let terms;
      try {
        terms = await dependencies.terms.accept({
          context: {
            accountId: reservation.accountId,
            vaultId: reservation.vaultId,
          },
          command: command.value,
          consentId: consentId.value,
          acceptedAt: now,
        });
      } catch {
        return rejected('unavailable');
      }
      if (terms.kind === 'rejected') {
        return rejected(mapTermsFailure(terms.reason));
      }
      if (terms.status.kind !== 'accepted') return rejected('terms-changed');

      const plan = planSignupAdmission({
        identity: identity.value,
        submissionId: command.value.submissionId,
        reservation,
        evidence: {
          submissionId: command.value.submissionId,
          accountId: reservation.accountId,
          vaultId: reservation.vaultId,
          consentId: terms.status.accepted.consentId,
        },
      });
      if (plan.kind === 'rejected') {
        return rejected(
          plan.reason === 'owner-mismatch'
            ? 'owner-mismatch'
            : 'provisioning-conflict',
        );
      }

      let finalizedCandidate: unknown;
      try {
        finalizedCandidate = await dependencies.provisioning.finalize({
          reservation: plan.reservation,
          termsConsentId: plan.consentId,
        });
      } catch {
        return rejected('unavailable');
      }
      const finalized =
        signupFinalizationResultDecoder.decode(finalizedCandidate);
      if (!finalized.ok) return rejected('unavailable');
      if (finalized.value.kind === 'conflict') {
        return rejected('provisioning-conflict');
      }
      const receipt = signupAdmissionReceiptDecoder.decode(
        finalized.value.receipt,
      );
      if (!receipt.ok || !signupReceiptMatchesPlan(receipt.value, plan)) {
        return rejected('provisioning-conflict');
      }
      return {
        kind: 'admitted',
        outcome: finalized.value.kind === 'created' ? 'created' : 'replayed',
        receipt: receipt.value,
      };
    },
  };
}

function mapTermsFailure(
  reason: Extract<
    Awaited<ReturnType<TermsConsentApplication['accept']>>,
    { readonly kind: 'rejected' }
  >['reason'],
): Extract<SignupAdmissionResult, { readonly kind: 'rejected' }>['reason'] {
  switch (reason) {
    case 'consent-required':
    case 'invalid-command':
      return 'terms-consent-required';
    case 'stale-terms':
    case 'classification-required':
    case 'inconsistent-evidence':
      return 'terms-changed';
    case 'owner-mismatch':
      return 'owner-mismatch';
    case 'invalid-current-terms':
    case 'hash-unavailable':
    case 'identifier-conflict':
    case 'unavailable':
      return 'unavailable';
  }
}

function rejected(
  reason: Extract<
    SignupAdmissionResult,
    { readonly kind: 'rejected' }
  >['reason'],
): SignupAdmissionResult {
  return { kind: 'rejected', reason };
}
