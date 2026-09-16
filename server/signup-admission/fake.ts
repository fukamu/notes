import type {
  AccountId,
  IdentityId,
  SessionEpoch,
  SessionId,
  VaultId,
} from '../../lib/domain/identity';
import type { SignupAdmissionIdPort } from './application';
import type {
  SignupAdmissionPort,
  SignupAdmissionReceipt,
  SignupAdmissionReservation,
  SignupProvisioningPort,
  VerifiedSignupIdentity,
} from './public';
import type {
  TermsConsentId,
  TermsConsentSubmissionId,
} from '../terms-consent/public';

export type FakeSignupAllocation = Readonly<{
  accountId: AccountId;
  vaultId: VaultId;
  identityId: IdentityId;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
}>;

export type FakeSignupProvisioning = SignupProvisioningPort & {
  readonly reservations: () => readonly SignupAdmissionReservation[];
  readonly receipts: () => readonly SignupAdmissionReceipt[];
  readonly finalizationCount: () => number;
};

export function createFakeSignupProvisioning(
  allocations: readonly FakeSignupAllocation[],
): FakeSignupProvisioning {
  const available = [...allocations];
  const reservations = new Map<
    TermsConsentSubmissionId,
    SignupAdmissionReservation
  >();
  const receipts = new Map<TermsConsentSubmissionId, SignupAdmissionReceipt>();
  let finalizationCount = 0;
  return {
    async reserve(input) {
      const existing = reservations.get(input.submissionId);
      if (existing !== undefined) {
        return sameIdentity(existing.identity, input.identity)
          ? { kind: 'reserved', reservation: existing }
          : { kind: 'conflict' };
      }
      const allocation = available.shift();
      if (allocation === undefined)
        throw new Error('fake signup allocation exhausted');
      const reservation: SignupAdmissionReservation = {
        submissionId: input.submissionId,
        identity: input.identity,
        ...allocation,
      };
      reservations.set(input.submissionId, reservation);
      return { kind: 'reserved', reservation };
    },
    async finalize(input) {
      const reserved = reservations.get(input.reservation.submissionId);
      if (
        reserved === undefined ||
        !sameReservation(reserved, input.reservation)
      ) {
        return { kind: 'conflict' };
      }
      const existing = receipts.get(input.reservation.submissionId);
      if (existing !== undefined) {
        return existing.termsConsentId === input.termsConsentId
          ? { kind: 'existing', receipt: existing }
          : { kind: 'conflict' };
      }
      const receipt: SignupAdmissionReceipt = {
        ...input.reservation,
        termsConsentId: input.termsConsentId,
      };
      receipts.set(input.reservation.submissionId, receipt);
      finalizationCount += 1;
      return { kind: 'created', receipt };
    },
    reservations: () => [...reservations.values()],
    receipts: () => [...receipts.values()],
    finalizationCount: () => finalizationCount,
  };
}

export function createFakeSignupAdmissionIds(
  values: readonly TermsConsentId[],
): SignupAdmissionIdPort {
  const available = [...values];
  return {
    async createTermsConsentId() {
      const value = available.shift();
      if (value === undefined)
        throw new Error('fake consent identifier exhausted');
      return value;
    },
  };
}

export function createDenyingSignupAdmission(): SignupAdmissionPort {
  return {
    async admit() {
      return { kind: 'rejected', reason: 'unavailable' };
    },
  };
}

function sameIdentity(
  left: VerifiedSignupIdentity,
  right: VerifiedSignupIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameReservation(
  left: SignupAdmissionReservation,
  right: SignupAdmissionReservation,
): boolean {
  return (
    left.submissionId === right.submissionId &&
    sameIdentity(left.identity, right.identity) &&
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.identityId === right.identityId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}
