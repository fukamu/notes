import {
  booleanDecoder,
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { TermsConsentCheckoutVerifierPort } from '../terms-consent/public';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

declare const contractIdentifierBrand: unique symbol;
declare const contractOfferHashBrand: unique symbol;

type ContractIdentifier<TName extends string> = string & {
  readonly [contractIdentifierBrand]: TName;
};

export type ContractEvidenceId = ContractIdentifier<'ContractEvidenceId'>;
export type ContractSubmissionId = ContractIdentifier<'ContractSubmissionId'>;
export type ContractOfferHash = string & {
  readonly [contractOfferHashBrand]: 'ContractOfferHash';
};
export type ContractEvidenceScope = Pick<VaultContext, 'accountId' | 'vaultId'>;

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

function brandedUuidDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(uuidV7Decoder, (value) => value as TValue);
}

export const contractEvidenceIdDecoder =
  brandedUuidDecoder<ContractEvidenceId>();
export const contractSubmissionIdDecoder =
  brandedUuidDecoder<ContractSubmissionId>();
export const contractOfferHashDecoder: Decoder<ContractOfferHash> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 71, maxLength: 71 }),
      (value) => /^sha256:[a-f0-9]{64}$/.test(value),
      'expected a lowercase SHA-256 digest',
    ),
    (value) => value as ContractOfferHash,
  );

export function parseContractEvidenceId(input: unknown): ContractEvidenceId {
  return decodeOrThrow(contractEvidenceIdDecoder, input, 'ContractEvidenceId');
}

export function parseContractSubmissionId(
  input: unknown,
): ContractSubmissionId {
  return decodeOrThrow(
    contractSubmissionIdDecoder,
    input,
    'ContractSubmissionId',
  );
}

export function parseContractOfferHash(input: unknown): ContractOfferHash {
  return decodeOrThrow(contractOfferHashDecoder, input, 'ContractOfferHash');
}

export type ContractConsent =
  | { readonly kind: 'not-affirmed' }
  | { readonly kind: 'affirmed' };

export type ContractOfferSnapshot = Readonly<{
  schemaVersion: 1;
  offerVersion: string;
  disclosureVersion: string;
  serviceName: 'FUKAMU Notes';
  quantity: 'one-personal-vault';
  planName: string;
  priceYen: number;
  billingPeriod: 'monthly' | 'annual';
  taxIncluded: true;
  trialDays: 14;
  trialPriceYen: 0;
  firstChargeDay: 15;
  renewalChargeYen: number;
  annualEstimateYen: number;
  automaticRenewal: true;
  paymentMethod: 'credit-card';
  serviceStart: 'after-registration-and-payment-method-confirmation';
  servicePeriod: 'indefinite-until-cancelled';
  cancellationPolicy: string;
  refundPolicy: string;
  additionalFees: string;
  onlineLockPolicy: 'immediate-on-payment-failure-or-action-required';
  cancellationSeparateFromAccountDeletion: true;
}>;

const trueDecoder: Decoder<true> = transformDecoder(
  refineDecoder(booleanDecoder, (value) => value, 'expected true'),
  () => true,
);
const oneDecoder: Decoder<1> = transformDecoder(
  safeIntegerDecoder({ minimum: 1, maximum: 1 }),
  () => 1,
);
const zeroDecoder: Decoder<0> = transformDecoder(
  safeIntegerDecoder({ minimum: 0, maximum: 0 }),
  () => 0,
);
const fourteenDecoder: Decoder<14> = transformDecoder(
  safeIntegerDecoder({ minimum: 14, maximum: 14 }),
  () => 14,
);
const fifteenDecoder: Decoder<15> = transformDecoder(
  safeIntegerDecoder({ minimum: 15, maximum: 15 }),
  () => 15,
);
const dateVersionDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  'expected YYYY-MM-DD',
);

export const contractOfferSnapshotDecoder: Decoder<ContractOfferSnapshot> =
  objectDecoder({
    schemaVersion: oneDecoder,
    offerVersion: refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 128 }),
      (value) => /^legal-commerce-v1:\d{4}-\d{2}-\d{2}$/.test(value),
      'expected versioned legal commerce offer',
    ),
    disclosureVersion: dateVersionDecoder,
    serviceName: literalDecoder('FUKAMU Notes'),
    quantity: literalDecoder('one-personal-vault'),
    planName: stringDecoder({ minLength: 1, maxLength: 200 }),
    priceYen: safeIntegerDecoder({ minimum: 1, maximum: 10_000_000 }),
    billingPeriod: unionDecoder(
      literalDecoder('monthly'),
      literalDecoder('annual'),
    ),
    taxIncluded: trueDecoder,
    trialDays: fourteenDecoder,
    trialPriceYen: zeroDecoder,
    firstChargeDay: fifteenDecoder,
    renewalChargeYen: safeIntegerDecoder({
      minimum: 1,
      maximum: 10_000_000,
    }),
    annualEstimateYen: safeIntegerDecoder({
      minimum: 1,
      maximum: 120_000_000,
    }),
    automaticRenewal: trueDecoder,
    paymentMethod: literalDecoder('credit-card'),
    serviceStart: literalDecoder(
      'after-registration-and-payment-method-confirmation',
    ),
    servicePeriod: literalDecoder('indefinite-until-cancelled'),
    cancellationPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    refundPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    additionalFees: stringDecoder({ minLength: 1, maxLength: 500 }),
    onlineLockPolicy: literalDecoder(
      'immediate-on-payment-failure-or-action-required',
    ),
    cancellationSeparateFromAccountDeletion: trueDecoder,
  });

export type ContractConfirmationCommand = {
  readonly submissionId: ContractSubmissionId;
  readonly presentedOfferHash: ContractOfferHash;
  readonly consent: ContractConsent;
};

export const contractConfirmationCommandDecoder: Decoder<ContractConfirmationCommand> =
  objectDecoder({
    submissionId: contractSubmissionIdDecoder,
    presentedOfferHash: contractOfferHashDecoder,
    consent: unionDecoder(
      objectDecoder({ kind: literalDecoder('not-affirmed') }),
      objectDecoder({ kind: literalDecoder('affirmed') }),
    ),
  });

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
