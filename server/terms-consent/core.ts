import {
  decodeLegalTermsDisclosure,
  type LegalTermsDisclosure,
} from '../../lib/application/legal-terms';
import type { VaultContext } from '../../lib/domain/identity';
import {
  termsVersionDecoder,
  type TermsConsentCommand,
  type TermsConsentId,
  type TermsConsentRecord,
  type TermsConsentSnapshot,
  type TermsDocumentHash,
} from './public';

export type TermsConsentSnapshotPlan =
  | { readonly kind: 'ready'; readonly snapshot: TermsConsentSnapshot }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-terms' };

export type TermsConsentPlan =
  | { readonly kind: 'append'; readonly record: TermsConsentRecord }
  | { readonly kind: 'replay'; readonly record: TermsConsentRecord }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-command'
        | 'consent-required'
        | 'stale-terms'
        | 'owner-mismatch'
        | 'identifier-conflict';
    };

export function serializeTermsDisclosure(
  disclosure: LegalTermsDisclosure,
): string {
  return JSON.stringify({
    schemaVersion: disclosure.schemaVersion,
    termsVersion: disclosure.termsVersion,
    effectiveDate: disclosure.effectiveDate,
    serviceName: disclosure.serviceName,
    operator: {
      legalName: disclosure.operator.legalName,
      supportUrl: disclosure.operator.supportUrl,
    },
    serviceEligibility: disclosure.serviceEligibility,
    accountSecurity: disclosure.accountSecurity,
    authentication: {
      googleLogin: disclosure.authentication.googleLogin,
      emailOtp: disclosure.authentication.emailOtp,
      password: disclosure.authentication.password,
      sharedVault: disclosure.authentication.sharedVault,
    },
    prohibitedActivities: [...disclosure.prohibitedActivities],
    userContent: {
      ownership: disclosure.userContent.ownership,
      licenseScope: disclosure.userContent.licenseScope,
      licensePurpose: disclosure.userContent.licensePurpose,
    },
    billing: {
      paidOnly: disclosure.billing.paidOnly,
      trialDays: disclosure.billing.trialDays,
      firstChargeDay: disclosure.billing.firstChargeDay,
      automaticRenewal: disclosure.billing.automaticRenewal,
      cancellationPolicy: disclosure.billing.cancellationPolicy,
      refundPolicy: disclosure.billing.refundPolicy,
      paymentFailureLock: disclosure.billing.paymentFailureLock,
      resumePolicy: disclosure.billing.resumePolicy,
      cancellationSeparateFromAccountDeletion:
        disclosure.billing.cancellationSeparateFromAccountDeletion,
    },
    dataHandling: {
      oneAccountOnePersonalVault:
        disclosure.dataHandling.oneAccountOnePersonalVault,
      localContentOnLogout: disclosure.dataHandling.localContentOnLogout,
      liveDataOnAccountDeletion:
        disclosure.dataHandling.liveDataOnAccountDeletion,
      backupMaximumDays: disclosure.dataHandling.backupMaximumDays,
    },
    suspensionPolicy: disclosure.suspensionPolicy,
    maintenanceAndChanges: disclosure.maintenanceAndChanges,
    serviceTermination: disclosure.serviceTermination,
    intellectualProperty: disclosure.intellectualProperty,
    liability: disclosure.liability,
    notices: disclosure.notices,
    governingLawAndVenue: disclosure.governingLawAndVenue,
    amendments: {
      procedure: disclosure.amendments.procedure,
      materialChangeHandling: disclosure.amendments.materialChangeHandling,
    },
  });
}

export function planTermsConsentSnapshot(input: {
  readonly disclosure: unknown;
  readonly termsHash: TermsDocumentHash;
}): TermsConsentSnapshotPlan {
  const decoded = decodeLegalTermsDisclosure(input.disclosure);
  if (decoded.kind === 'invalid') {
    return { kind: 'rejected', reason: 'invalid-terms' };
  }
  const version = termsVersionDecoder.decode(decoded.disclosure.termsVersion);
  if (!version.ok) return { kind: 'rejected', reason: 'invalid-terms' };
  return {
    kind: 'ready',
    snapshot: {
      termsVersion: version.value,
      termsHash: input.termsHash,
      disclosure: decoded.disclosure,
      serializedTerms: serializeTermsDisclosure(decoded.disclosure),
    },
  };
}

export function planTermsConsent(input: {
  readonly context: VaultContext;
  readonly command: TermsConsentCommand;
  readonly snapshot: TermsConsentSnapshot;
  readonly consentId: TermsConsentId;
  readonly acceptedAt: number;
  readonly existing: TermsConsentRecord | undefined;
}): TermsConsentPlan {
  if (
    !validTimestamp(input.acceptedAt) ||
    input.snapshot.serializedTerms !==
      serializeTermsDisclosure(input.snapshot.disclosure) ||
    input.snapshot.termsVersion !== input.snapshot.disclosure.termsVersion
  ) {
    return { kind: 'rejected', reason: 'invalid-command' };
  }
  if (input.command.consent.kind !== 'affirmed') {
    return { kind: 'rejected', reason: 'consent-required' };
  }
  if (
    input.command.presentedTermsVersion !== input.snapshot.termsVersion ||
    input.command.presentedTermsHash !== input.snapshot.termsHash
  ) {
    return { kind: 'rejected', reason: 'stale-terms' };
  }

  const existing = input.existing;
  if (existing !== undefined) {
    if (!sameScope(existing.scope, input.context)) {
      return { kind: 'rejected', reason: 'owner-mismatch' };
    }
    if (!sameSubmissionPayload(existing, input.command, input.snapshot)) {
      return { kind: 'rejected', reason: 'identifier-conflict' };
    }
    return { kind: 'replay', record: existing };
  }

  return {
    kind: 'append',
    record: {
      scope: {
        accountId: input.context.accountId,
        vaultId: input.context.vaultId,
      },
      consentId: input.consentId,
      submissionId: input.command.submissionId,
      snapshot: input.snapshot,
      consent: 'affirmed',
      acceptedAt: input.acceptedAt,
    },
  };
}

export function termsConsentRecordMatchesContext(
  record: TermsConsentRecord,
  context: VaultContext,
): boolean {
  return sameScope(record.scope, context);
}

function sameSubmissionPayload(
  existing: TermsConsentRecord,
  command: TermsConsentCommand,
  snapshot: TermsConsentSnapshot,
): boolean {
  return (
    existing.submissionId === command.submissionId &&
    existing.snapshot.termsVersion === snapshot.termsVersion &&
    existing.snapshot.termsHash === snapshot.termsHash &&
    existing.snapshot.serializedTerms === snapshot.serializedTerms &&
    existing.consent === 'affirmed'
  );
}

function sameScope(
  left: TermsConsentRecord['scope'],
  right: VaultContext,
): boolean {
  return left.accountId === right.accountId && left.vaultId === right.vaultId;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
