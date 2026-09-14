import type { VaultContext } from '../../lib/domain/identity';
import type {
  TermsAcceptancePolicy,
  TermsConsentId,
  TermsConsentRecord,
  TermsConsentSnapshot,
  TermsDocumentHash,
  TermsVersion,
} from './public';

export type CurrentTermsReference = Readonly<{
  termsVersion: TermsVersion;
  termsHash: TermsDocumentHash;
  effectiveDate: string;
}>;

export type AcceptedTermsReference = Readonly<{
  consentId: TermsConsentId;
  termsVersion: TermsVersion;
  termsHash: TermsDocumentHash;
  acceptedAt: number;
}>;

export type TermsConsentStatus =
  | {
      readonly kind: 'current';
      readonly acceptanceRequired: true;
      readonly current: CurrentTermsReference;
    }
  | {
      readonly kind: 'accepted';
      readonly acceptanceRequired: false;
      readonly current: CurrentTermsReference;
      readonly accepted: AcceptedTermsReference;
    }
  | {
      readonly kind: 'reconsent-required';
      readonly acceptanceRequired: true;
      readonly current: CurrentTermsReference;
      readonly accepted: AcceptedTermsReference;
    }
  | {
      readonly kind: 'notice-only';
      readonly acceptanceRequired: false;
      readonly current: CurrentTermsReference;
      readonly accepted: AcceptedTermsReference;
    };

export type TermsConsentStatusPlan =
  | { readonly kind: 'resolved'; readonly status: TermsConsentStatus }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'owner-mismatch'
        | 'classification-required'
        | 'inconsistent-evidence';
    };

export function decideTermsConsentStatus(input: {
  readonly context: VaultContext;
  readonly current: TermsConsentSnapshot;
  readonly latest: TermsConsentRecord | undefined;
  readonly acceptancePolicy: TermsAcceptancePolicy;
}): TermsConsentStatusPlan {
  const current = currentReference(input.current);
  if (input.latest === undefined) {
    return {
      kind: 'resolved',
      status: { kind: 'current', acceptanceRequired: true, current },
    };
  }
  if (!matchesContext(input.latest, input.context)) {
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }

  const latest = input.latest;
  const sameVersion =
    latest.snapshot.termsVersion === input.current.termsVersion;
  const sameHash = latest.snapshot.termsHash === input.current.termsHash;
  const sameSnapshot =
    latest.snapshot.serializedTerms === input.current.serializedTerms;
  const accepted = acceptedReference(latest);
  if (sameVersion && sameHash && sameSnapshot) {
    return {
      kind: 'resolved',
      status: {
        kind: 'accepted',
        acceptanceRequired: false,
        current,
        accepted,
      },
    };
  }
  if (sameVersion || sameHash) {
    return { kind: 'rejected', reason: 'inconsistent-evidence' };
  }

  switch (input.acceptancePolicy.kind) {
    case 'reconsent-required':
      return {
        kind: 'resolved',
        status: {
          kind: 'reconsent-required',
          acceptanceRequired: true,
          current,
          accepted,
        },
      };
    case 'notice-only':
      return {
        kind: 'resolved',
        status: {
          kind: 'notice-only',
          acceptanceRequired: false,
          current,
          accepted,
        },
      };
    case 'initial-release':
    case 'undecided':
      return { kind: 'rejected', reason: 'classification-required' };
  }
}

export function acceptedTermsStatus(input: {
  readonly current: TermsConsentSnapshot;
  readonly record: TermsConsentRecord;
}): TermsConsentStatusPlan {
  if (
    input.record.snapshot.termsVersion !== input.current.termsVersion ||
    input.record.snapshot.termsHash !== input.current.termsHash ||
    input.record.snapshot.serializedTerms !== input.current.serializedTerms
  ) {
    return { kind: 'rejected', reason: 'inconsistent-evidence' };
  }
  return {
    kind: 'resolved',
    status: {
      kind: 'accepted',
      acceptanceRequired: false,
      current: currentReference(input.current),
      accepted: acceptedReference(input.record),
    },
  };
}

function currentReference(
  snapshot: TermsConsentSnapshot,
): CurrentTermsReference {
  return {
    termsVersion: snapshot.termsVersion,
    termsHash: snapshot.termsHash,
    effectiveDate: snapshot.disclosure.effectiveDate,
  };
}

function acceptedReference(record: TermsConsentRecord): AcceptedTermsReference {
  return {
    consentId: record.consentId,
    termsVersion: record.snapshot.termsVersion,
    termsHash: record.snapshot.termsHash,
    acceptedAt: record.acceptedAt,
  };
}

function matchesContext(
  record: TermsConsentRecord,
  context: VaultContext,
): boolean {
  return (
    record.scope.accountId === context.accountId &&
    record.scope.vaultId === context.vaultId
  );
}
