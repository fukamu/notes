import type { VaultContext } from '../../lib/domain/identity';
import type {
  ContractConfirmationCommand,
  ContractEvidenceId,
  ContractEvidenceScope,
  ContractOfferHash,
  ContractOfferSnapshot,
  ContractSubmissionId,
} from '../../lib/contracts/contract-checkout';
import type { TermsConsentCheckoutVerifierPort } from '../terms-consent/public';

export {
  contractConfirmationCommandDecoder,
  contractEvidenceIdDecoder,
  contractOfferHashDecoder,
  contractOfferSnapshotDecoder,
  contractSubmissionIdDecoder,
  parseContractEvidenceId,
  parseContractOfferHash,
  parseContractSubmissionId,
  type ContractConfirmationCommand,
  type ContractConsent,
  type ContractEvidenceId,
  type ContractEvidenceScope,
  type ContractOfferHash,
  type ContractOfferSnapshot,
  type ContractSubmissionId,
} from '../../lib/contracts/contract-checkout';

export type ContractEvidenceRecord = Readonly<{
  scope: ContractEvidenceScope;
  evidenceId: ContractEvidenceId;
  submissionId: ContractSubmissionId;
  offerHash: ContractOfferHash;
  offer: ContractOfferSnapshot;
  serializedOffer: string;
  consent: 'affirmed';
  confirmedAt: number;
}>;

export type PreparedContractOffer = Readonly<{
  offer: ContractOfferSnapshot;
  serializedOffer: string;
  offerHash: ContractOfferHash;
}>;

export type PrepareContractOfferResult =
  | { readonly kind: 'available'; readonly prepared: PreparedContractOffer }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'invalid-offer' | 'hash-unavailable';
    };

export type ContractConfirmationResult =
  | {
      readonly kind: 'accepted';
      readonly outcome: 'recorded' | 'replayed';
      readonly evidence: ContractEvidenceRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-offer'
        | 'hash-unavailable'
        | 'invalid-command'
        | 'consent-required'
        | 'stale-offer'
        | 'owner-mismatch'
        | 'identifier-conflict'
        | 'unavailable';
    };

export type ContractConfirmationRejectionReason = Extract<
  ContractConfirmationResult,
  { readonly kind: 'rejected' }
>['reason'];

export type ContractOfferHasherPort = {
  hash(serializedOffer: string): Promise<unknown>;
};

export type ContractEvidenceAppendResult =
  | { readonly kind: 'created' }
  | {
      readonly kind: 'existing';
      readonly record: ContractEvidenceRecord;
    }
  | { readonly kind: 'conflict' };

export type ContractEvidenceRepository = {
  findBySubmission(
    context: VaultContext,
    submissionId: ContractSubmissionId,
  ): Promise<ContractEvidenceRecord | undefined>;
  append(record: ContractEvidenceRecord): Promise<ContractEvidenceAppendResult>;
};

export type ContractEvidenceService = {
  prepareOffer(disclosure: unknown): Promise<PrepareContractOfferResult>;
  confirm(input: {
    readonly context: VaultContext;
    readonly disclosure: unknown;
    readonly command: ContractConfirmationCommand;
    readonly evidenceId: ContractEvidenceId;
    readonly confirmedAt: number;
  }): Promise<ContractConfirmationResult>;
};

export type ContractOfferSourcePort = {
  readCurrent(): unknown;
};

export type ContractCheckoutResult =
  | {
      readonly kind: 'redirect';
      readonly evidenceOutcome: 'recorded' | 'replayed';
      readonly evidence: ContractEvidenceRecord;
      readonly checkoutUrl: string;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | ContractConfirmationRejectionReason
        | 'provider-unavailable'
        | 'malformed-provider-response'
        | 'provider-mapping-mismatch'
        | 'billing-rejected'
        | 'terms-consent-required'
        | 'terms-changed';
    };

export type ContractCheckoutApplication = {
  prepareOffer(): Promise<PrepareContractOfferResult>;
  confirm(input: {
    readonly context: VaultContext;
    readonly command: ContractConfirmationCommand;
    readonly evidenceId: ContractEvidenceId;
    readonly confirmedAt: number;
  }): Promise<ContractCheckoutResult>;
};

export type ContractCheckoutTermsVerifier = TermsConsentCheckoutVerifierPort;
