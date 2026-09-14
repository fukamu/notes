import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  emailOtpAddressDecoder,
  type EmailOtpAddress,
} from '../../lib/domain/email-otp';
import {
  accountIdDecoder,
  identityIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type IdentityId,
  type SessionEpoch,
  type SessionId,
  type VaultId,
} from '../../lib/domain/identity';
import {
  oidcEmailAddressDecoder,
  oidcIssuerDecoder,
  oidcSubjectDecoder,
  type OidcEmailAddress,
  type OidcIssuer,
  type OidcSubject,
} from '../../lib/domain/oidc';
import {
  termsConsentIdDecoder,
  termsConsentSubmissionIdDecoder,
  type TermsConsentCommand,
  type TermsConsentId,
  type TermsConsentSubmissionId,
} from '../terms-consent/public';

export type VerifiedSignupIdentity =
  | {
      readonly kind: 'google';
      readonly issuer: OidcIssuer;
      readonly subject: OidcSubject;
      readonly email: OidcEmailAddress;
    }
  | { readonly kind: 'email-otp'; readonly address: EmailOtpAddress };

export const verifiedSignupIdentityDecoder: Decoder<VerifiedSignupIdentity> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('google'),
      issuer: oidcIssuerDecoder,
      subject: oidcSubjectDecoder,
      email: oidcEmailAddressDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('email-otp'),
      address: emailOtpAddressDecoder,
    }),
  );

export type SignupAdmissionReservation = Readonly<{
  submissionId: TermsConsentSubmissionId;
  identity: VerifiedSignupIdentity;
  accountId: AccountId;
  vaultId: VaultId;
  identityId: IdentityId;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
}>;

const initialSessionEpochDecoder = refineDecoder(
  sessionEpochDecoder,
  (epoch) => epoch === 1,
  'expected the initial session epoch',
);

export const signupAdmissionReservationDecoder: Decoder<SignupAdmissionReservation> =
  transformDecoder(
    objectDecoder({
      submissionId: termsConsentSubmissionIdDecoder,
      identity: verifiedSignupIdentityDecoder,
      accountId: accountIdDecoder,
      vaultId: vaultIdDecoder,
      identityId: identityIdDecoder,
      sessionId: sessionIdDecoder,
      sessionEpoch: initialSessionEpochDecoder,
    }),
    (reservation): SignupAdmissionReservation => reservation,
  );

export type SignupAdmissionReceipt = SignupAdmissionReservation &
  Readonly<{ termsConsentId: TermsConsentId }>;

export const signupAdmissionReceiptDecoder: Decoder<SignupAdmissionReceipt> =
  transformDecoder(
    objectDecoder({
      submissionId: termsConsentSubmissionIdDecoder,
      identity: verifiedSignupIdentityDecoder,
      accountId: accountIdDecoder,
      vaultId: vaultIdDecoder,
      identityId: identityIdDecoder,
      sessionId: sessionIdDecoder,
      sessionEpoch: initialSessionEpochDecoder,
      termsConsentId: termsConsentIdDecoder,
    }),
    (receipt): SignupAdmissionReceipt => receipt,
  );

export type SignupReservationResult =
  | {
      readonly kind: 'reserved';
      readonly reservation: SignupAdmissionReservation;
    }
  | { readonly kind: 'conflict' };

export const signupReservationResultDecoder: Decoder<SignupReservationResult> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('reserved'),
      reservation: signupAdmissionReservationDecoder,
    }),
    objectDecoder({ kind: literalDecoder('conflict') }),
  );

export type SignupFinalizationResult =
  | {
      readonly kind: 'created' | 'existing';
      readonly receipt: SignupAdmissionReceipt;
    }
  | { readonly kind: 'conflict' };

export const signupFinalizationResultDecoder: Decoder<SignupFinalizationResult> =
  unionDecoder(
    objectDecoder({
      kind: unionDecoder(literalDecoder('created'), literalDecoder('existing')),
      receipt: signupAdmissionReceiptDecoder,
    }),
    objectDecoder({ kind: literalDecoder('conflict') }),
  );

export type SignupProvisioningPort = {
  /** Reserves server-generated identifiers idempotently by submission ID. */
  reserve(input: {
    readonly submissionId: TermsConsentSubmissionId;
    readonly identity: VerifiedSignupIdentity;
  }): Promise<unknown>;
  /** Atomically persists identity/account/vault/session after terms acceptance. */
  finalize(input: {
    readonly reservation: SignupAdmissionReservation;
    readonly termsConsentId: TermsConsentId;
  }): Promise<unknown>;
};

export type SignupAdmissionResult =
  | {
      readonly kind: 'admitted';
      readonly outcome: 'created' | 'replayed';
      readonly receipt: SignupAdmissionReceipt;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'terms-consent-required'
        | 'terms-changed'
        | 'owner-mismatch'
        | 'provisioning-conflict'
        | 'unavailable';
    };

export type SignupAdmissionPort = {
  admit(input: {
    readonly identity: VerifiedSignupIdentity;
    readonly termsConsent: TermsConsentCommand;
  }): Promise<SignupAdmissionResult>;
};
