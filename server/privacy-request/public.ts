import { validate as validateUuid, version as uuidVersion } from 'uuid';
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
import type { PrivacyRequestKind } from '../../lib/domain/privacy-request';
import type { VaultContext } from '../../lib/domain/identity';

declare const privacyRequestIdentifierBrand: unique symbol;
declare const privacyRequestRevisionBrand: unique symbol;
declare const privacyRequestFailureCodeBrand: unique symbol;

type PrivacyRequestIdentifier<TName extends string> = string & {
  readonly [privacyRequestIdentifierBrand]: TName;
};

export type PrivacyRequestId = PrivacyRequestIdentifier<'PrivacyRequestId'>;
export type PrivacyRequestSubmissionId =
  PrivacyRequestIdentifier<'PrivacyRequestSubmissionId'>;
export type PrivacyRequestVerificationReceiptId =
  PrivacyRequestIdentifier<'PrivacyRequestVerificationReceiptId'>;
export type PrivacyRequestRevision = number & {
  readonly [privacyRequestRevisionBrand]: 'PrivacyRequestRevision';
};
export type PrivacyRequestFailureCode = string & {
  readonly [privacyRequestFailureCodeBrand]: 'PrivacyRequestFailureCode';
};
export type PrivacyRequestScope = Pick<VaultContext, 'accountId' | 'vaultId'>;

type VerifiedPrivacyRequest = {
  readonly verificationReceiptId: PrivacyRequestVerificationReceiptId;
  readonly verifiedAt: number;
};

export type PrivacyRequestOutcome = 'fulfilled' | 'account-deletion-started';

export type PrivacyRequestRejectionReason =
  | 'identity-not-verified'
  | 'request-not-applicable';

export type PrivacyRequestState =
  | { readonly kind: 'verification-pending' }
  | ({ readonly kind: 'ready' } & VerifiedPrivacyRequest)
  | ({
      readonly kind: 'processing';
      readonly startedAt: number;
    } & VerifiedPrivacyRequest)
  | ({
      readonly kind: 'completed';
      readonly startedAt: number;
      readonly completedAt: number;
      readonly outcome: PrivacyRequestOutcome;
    } & VerifiedPrivacyRequest)
  | {
      readonly kind: 'rejected';
      readonly rejectedAt: number;
      readonly reason: PrivacyRequestRejectionReason;
    }
  | ({
      readonly kind: 'failed';
      readonly startedAt: number;
      readonly failedAt: number;
      readonly failureCode: PrivacyRequestFailureCode;
      readonly retryable: boolean;
    } & VerifiedPrivacyRequest);

export type PrivacyRequestRecord = PrivacyRequestScope & {
  readonly requestId: PrivacyRequestId;
  readonly submissionId: PrivacyRequestSubmissionId;
  readonly requestKind: PrivacyRequestKind;
  readonly revision: PrivacyRequestRevision;
  readonly state: PrivacyRequestState;
  readonly requestedAt: number;
  readonly updatedAt: number;
};

export type PrivacyRequestTransition = {
  readonly current: PrivacyRequestRecord;
  readonly next: PrivacyRequestRecord;
};

export type PrivacyRequestCreateResult =
  | { readonly kind: 'created'; readonly record: PrivacyRequestRecord }
  | { readonly kind: 'existing'; readonly record: PrivacyRequestRecord }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-record' };

export type PrivacyRequestCommitResult =
  | { readonly kind: 'applied'; readonly record: PrivacyRequestRecord }
  | { readonly kind: 'replayed'; readonly record: PrivacyRequestRecord }
  | {
      readonly kind: 'conflict';
      readonly current: PrivacyRequestRecord | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-transition' };

export type PrivacyRequestRepository = {
  findById(
    scope: PrivacyRequestScope,
    requestId: PrivacyRequestId,
  ): Promise<PrivacyRequestRecord | undefined>;
  findBySubmission(
    scope: PrivacyRequestScope,
    submissionId: PrivacyRequestSubmissionId,
  ): Promise<PrivacyRequestRecord | undefined>;
  create(record: PrivacyRequestRecord): Promise<PrivacyRequestCreateResult>;
  commit(
    scope: PrivacyRequestScope,
    transition: PrivacyRequestTransition,
  ): Promise<PrivacyRequestCommitResult>;
};

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);
const timestampDecoder = safeIntegerDecoder({ minimum: 0 });

function brandedUuidDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(uuidV7Decoder, (value) => value as TValue);
}

export const privacyRequestIdDecoder = brandedUuidDecoder<PrivacyRequestId>();
export const privacyRequestSubmissionIdDecoder =
  brandedUuidDecoder<PrivacyRequestSubmissionId>();
export const privacyRequestVerificationReceiptIdDecoder =
  brandedUuidDecoder<PrivacyRequestVerificationReceiptId>();
export const privacyRequestRevisionDecoder: Decoder<PrivacyRequestRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as PrivacyRequestRevision,
  );
export const privacyRequestFailureCodeDecoder: Decoder<PrivacyRequestFailureCode> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 64 }),
      (value) => /^[a-z][a-z0-9-]*$/.test(value),
      'expected a lowercase non-sensitive failure code',
    ),
    (value) => value as PrivacyRequestFailureCode,
  );

export const privacyRequestKindDecoder: Decoder<PrivacyRequestKind> =
  unionDecoder(
    literalDecoder('purpose-notification'),
    literalDecoder('disclosure'),
    literalDecoder('correction'),
    literalDecoder('usage-suspension'),
    literalDecoder('deletion'),
    literalDecoder('third-party-provision-suspension'),
  );
export const privacyRequestOutcomeDecoder: Decoder<PrivacyRequestOutcome> =
  unionDecoder(
    literalDecoder('fulfilled'),
    literalDecoder('account-deletion-started'),
  );
export const privacyRequestRejectionReasonDecoder: Decoder<PrivacyRequestRejectionReason> =
  unionDecoder(
    literalDecoder('identity-not-verified'),
    literalDecoder('request-not-applicable'),
  );

export const privacyRequestStateDecoder: Decoder<PrivacyRequestState> =
  unionDecoder(
    objectDecoder({ kind: literalDecoder('verification-pending') }),
    objectDecoder({
      kind: literalDecoder('ready'),
      verificationReceiptId: privacyRequestVerificationReceiptIdDecoder,
      verifiedAt: timestampDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('processing'),
      verificationReceiptId: privacyRequestVerificationReceiptIdDecoder,
      verifiedAt: timestampDecoder,
      startedAt: timestampDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('completed'),
      verificationReceiptId: privacyRequestVerificationReceiptIdDecoder,
      verifiedAt: timestampDecoder,
      startedAt: timestampDecoder,
      completedAt: timestampDecoder,
      outcome: privacyRequestOutcomeDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('rejected'),
      rejectedAt: timestampDecoder,
      reason: privacyRequestRejectionReasonDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('failed'),
      verificationReceiptId: privacyRequestVerificationReceiptIdDecoder,
      verifiedAt: timestampDecoder,
      startedAt: timestampDecoder,
      failedAt: timestampDecoder,
      failureCode: privacyRequestFailureCodeDecoder,
      retryable: booleanDecoder,
    }),
  );

export function parsePrivacyRequestId(input: unknown): PrivacyRequestId {
  return decodeOrThrow(privacyRequestIdDecoder, input, 'PrivacyRequestId');
}

export function parsePrivacyRequestSubmissionId(
  input: unknown,
): PrivacyRequestSubmissionId {
  return decodeOrThrow(
    privacyRequestSubmissionIdDecoder,
    input,
    'PrivacyRequestSubmissionId',
  );
}

export function parsePrivacyRequestVerificationReceiptId(
  input: unknown,
): PrivacyRequestVerificationReceiptId {
  return decodeOrThrow(
    privacyRequestVerificationReceiptIdDecoder,
    input,
    'PrivacyRequestVerificationReceiptId',
  );
}

export function parsePrivacyRequestFailureCode(
  input: unknown,
): PrivacyRequestFailureCode {
  return decodeOrThrow(
    privacyRequestFailureCodeDecoder,
    input,
    'PrivacyRequestFailureCode',
  );
}

export function privacyRequestScope(
  scope: PrivacyRequestScope,
): PrivacyRequestScope {
  return { accountId: scope.accountId, vaultId: scope.vaultId };
}
