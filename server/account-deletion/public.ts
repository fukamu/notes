import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
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
import {
  accountIdDecoder,
  vaultIdDecoder,
  type VaultContext,
} from '../../lib/domain/identity';

declare const accountDeletionOperationIdBrand: unique symbol;
declare const accountDeletionRevisionBrand: unique symbol;
declare const accountDeletionAttemptBrand: unique symbol;
declare const accountDeletionFailureCodeBrand: unique symbol;
declare const accountDeletionIdempotencyKeyBrand: unique symbol;
declare const accountDeletionCredentialHashBrand: unique symbol;
declare const accountDeletionContinuationSecretBrand: unique symbol;
declare const accountDeletionContinuationTokenBrand: unique symbol;
declare const accountDeletionContinuationSequenceBrand: unique symbol;

export type AccountDeletionOperationId = string & {
  readonly [accountDeletionOperationIdBrand]: 'AccountDeletionOperationId';
};

export type AccountDeletionRevision = number & {
  readonly [accountDeletionRevisionBrand]: 'AccountDeletionRevision';
};

export type AccountDeletionAttempt = number & {
  readonly [accountDeletionAttemptBrand]: 'AccountDeletionAttempt';
};

export type AccountDeletionFailureCode = string & {
  readonly [accountDeletionFailureCodeBrand]: 'AccountDeletionFailureCode';
};

export type AccountDeletionIdempotencyKey = string & {
  readonly [accountDeletionIdempotencyKeyBrand]: 'AccountDeletionIdempotencyKey';
};

export type AccountDeletionCredentialHash = string & {
  readonly [accountDeletionCredentialHashBrand]: 'AccountDeletionCredentialHash';
};

export type AccountDeletionContinuationSecret = string & {
  readonly [accountDeletionContinuationSecretBrand]: 'AccountDeletionContinuationSecret';
};

export type AccountDeletionContinuationToken = string & {
  readonly [accountDeletionContinuationTokenBrand]: 'AccountDeletionContinuationToken';
};

export type AccountDeletionContinuationSequence = number & {
  readonly [accountDeletionContinuationSequenceBrand]: 'AccountDeletionContinuationSequence';
};

export type AccountDeletionScope = Pick<VaultContext, 'accountId' | 'vaultId'>;

export const accountDeletionSteps = [
  'revoke-sessions',
  'cancel-subscription',
  'delete-vault-data',
  'delete-private-objects',
  'finalize-account',
] as const;

export type AccountDeletionStep = (typeof accountDeletionSteps)[number];

export type AccountDeletionState =
  | {
      readonly kind: 'ready';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly notBefore: number;
    }
  | {
      readonly kind: 'running';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly leaseExpiresAt: number;
    }
  | {
      readonly kind: 'retry-wait';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly retryAt: number;
      readonly failureCode: AccountDeletionFailureCode;
    }
  | {
      readonly kind: 'terminal-failure';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly failureCode: AccountDeletionFailureCode;
    }
  | { readonly kind: 'completed'; readonly completedAt: number };

export type AccountDeletionOperation = AccountDeletionScope & {
  readonly operationId: AccountDeletionOperationId;
  readonly revision: AccountDeletionRevision;
  readonly state: AccountDeletionState;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AccountDeletionStepReceipt = {
  readonly operationId: AccountDeletionOperationId;
  readonly step: AccountDeletionStep;
  readonly completedAt: number;
};

export type AccountDeletionSnapshot = {
  readonly operation: AccountDeletionOperation;
  readonly receipts: readonly AccountDeletionStepReceipt[];
};

export type AccountDeletionTransition = {
  readonly current: AccountDeletionOperation;
  readonly next: AccountDeletionOperation;
  readonly receipt?: AccountDeletionStepReceipt;
};

export type AccountDeletionCreateResult =
  | { readonly kind: 'created'; readonly snapshot: AccountDeletionSnapshot }
  | { readonly kind: 'existing'; readonly snapshot: AccountDeletionSnapshot }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-operation' };

export type AccountDeletionCommitResult =
  | { readonly kind: 'applied'; readonly snapshot: AccountDeletionSnapshot }
  | { readonly kind: 'replayed'; readonly snapshot: AccountDeletionSnapshot }
  | {
      readonly kind: 'conflict';
      readonly current: AccountDeletionSnapshot | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-transition' };

export type AccountDeletionRepository = {
  readonly findByOwner: (
    scope: AccountDeletionScope,
  ) => Promise<AccountDeletionSnapshot | undefined>;
  readonly create: (
    operation: AccountDeletionOperation,
  ) => Promise<AccountDeletionCreateResult>;
  readonly commit: (
    scope: AccountDeletionScope,
    transition: AccountDeletionTransition,
  ) => Promise<AccountDeletionCommitResult>;
};

export type AccountDeletionContinuation = {
  readonly operationId: AccountDeletionOperationId;
  readonly idempotencyKeyHash: AccountDeletionCredentialHash;
  readonly secretHash: AccountDeletionCredentialHash;
  readonly sequence: AccountDeletionContinuationSequence;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AccountDeletionAuthorizedSnapshot = {
  readonly snapshot: AccountDeletionSnapshot;
  readonly continuation: AccountDeletionContinuation;
};

export type AccountDeletionAccessStartResult =
  | ({
      readonly kind: 'created' | 'existing';
    } & AccountDeletionAuthorizedSnapshot)
  | {
      readonly kind: 'rejected';
      readonly reason: 'credential-conflict' | 'invalid-start';
    };

export type AccountDeletionAccessConsumeResult =
  | ({
      readonly kind: 'consumed' | 'replayed';
    } & AccountDeletionAuthorizedSnapshot)
  | {
      readonly kind: 'rejected';
      readonly reason: 'expired' | 'invalid-capability';
    };

export type AccountDeletionAccessRepository = AccountDeletionRepository & {
  startWithContinuation(input: {
    readonly operation: AccountDeletionOperation;
    readonly continuation: AccountDeletionContinuation;
  }): Promise<AccountDeletionAccessStartResult>;
  consumeContinuation(input: {
    readonly secretHash: AccountDeletionCredentialHash;
    readonly sequence: AccountDeletionContinuationSequence;
    readonly consumedAt: number;
  }): Promise<AccountDeletionAccessConsumeResult>;
};

export type AccountDeletionPublicStatus =
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'retry-wait'; readonly retryAt: number }
  | { readonly kind: 'failed' }
  | { readonly kind: 'completed' };

export type AccountDeletionStartRequest = {
  readonly idempotencyKey: AccountDeletionIdempotencyKey;
};

export type AccountDeletionResumeRequest = {
  readonly continuationToken: AccountDeletionContinuationToken;
};

export type AccountDeletionContinuationCredentialsPort = {
  digest(value: string): Promise<unknown>;
  deriveSecret(input: {
    readonly scope: AccountDeletionScope;
    readonly idempotencyKey: AccountDeletionIdempotencyKey;
  }): Promise<unknown>;
};

export type AccountDeletionOperationIdGeneratorPort = {
  create(): unknown;
};

export type AccountDeletionApplicationResult =
  | {
      readonly kind: 'accepted';
      readonly status: Extract<
        AccountDeletionPublicStatus,
        { readonly kind: 'in-progress' | 'retry-wait' }
      >;
      readonly continuationToken: AccountDeletionContinuationToken;
    }
  | {
      readonly kind: 'accepted';
      readonly status: Extract<
        AccountDeletionPublicStatus,
        { readonly kind: 'failed' | 'completed' }
      >;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'credential-conflict'
        | 'invalid-capability'
        | 'invalid-input'
        | 'unavailable';
    };

export type AccountDeletionApplication = {
  start(input: {
    readonly scope: AccountDeletionScope;
    readonly idempotencyKey: AccountDeletionIdempotencyKey;
    readonly requestedAt: number;
  }): Promise<AccountDeletionApplicationResult>;
  resume(input: {
    readonly token: AccountDeletionContinuationToken;
    readonly resumedAt: number;
  }): Promise<AccountDeletionApplicationResult>;
};

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);
const timestampDecoder = safeIntegerDecoder({ minimum: 0 });

export const accountDeletionOperationIdDecoder: Decoder<AccountDeletionOperationId> =
  transformDecoder(
    uuidV7Decoder,
    (value) => value as AccountDeletionOperationId,
  );

export const accountDeletionRevisionDecoder: Decoder<AccountDeletionRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as AccountDeletionRevision,
  );

export const accountDeletionAttemptDecoder: Decoder<AccountDeletionAttempt> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 0, maximum: 1_000 }),
    (value) => value as AccountDeletionAttempt,
  );

export const accountDeletionFailureCodeDecoder: Decoder<AccountDeletionFailureCode> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 64 }),
      (value) => /^[a-z][a-z0-9-]*$/.test(value),
      'expected a lowercase non-sensitive failure code',
    ),
    (value) => value as AccountDeletionFailureCode,
  );

const base64Url256Decoder = refineDecoder(
  stringDecoder({ minLength: 43, maxLength: 43 }),
  (value) => /^[A-Za-z0-9_-]{43}$/.test(value),
  'expected an unpadded 256-bit base64url value',
);

export const accountDeletionIdempotencyKeyDecoder: Decoder<AccountDeletionIdempotencyKey> =
  transformDecoder(
    base64Url256Decoder,
    (value) => value as AccountDeletionIdempotencyKey,
  );

export const accountDeletionCredentialHashDecoder: Decoder<AccountDeletionCredentialHash> =
  transformDecoder(
    base64Url256Decoder,
    (value) => value as AccountDeletionCredentialHash,
  );

export const accountDeletionContinuationSecretDecoder: Decoder<AccountDeletionContinuationSecret> =
  transformDecoder(
    base64Url256Decoder,
    (value) => value as AccountDeletionContinuationSecret,
  );

export const accountDeletionContinuationSequenceDecoder: Decoder<AccountDeletionContinuationSequence> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 0, maximum: 2_147_483_647 }),
    (value) => value as AccountDeletionContinuationSequence,
  );

export const accountDeletionContinuationTokenDecoder: Decoder<AccountDeletionContinuationToken> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 49, maxLength: 59 }),
      (value) => /^ad1\.[A-Za-z0-9_-]{43}\.(?:0|[1-9][0-9]{0,9})$/.test(value),
      'expected an account deletion continuation token',
    ),
    (value) => value as AccountDeletionContinuationToken,
  );

export const accountDeletionStartRequestDecoder: Decoder<AccountDeletionStartRequest> =
  objectDecoder({ idempotencyKey: accountDeletionIdempotencyKeyDecoder });

export const accountDeletionResumeRequestDecoder: Decoder<AccountDeletionResumeRequest> =
  objectDecoder({
    continuationToken: accountDeletionContinuationTokenDecoder,
  });

export const accountDeletionStepDecoder: Decoder<AccountDeletionStep> =
  unionDecoder(
    literalDecoder('revoke-sessions'),
    literalDecoder('cancel-subscription'),
    literalDecoder('delete-vault-data'),
    literalDecoder('delete-private-objects'),
    literalDecoder('finalize-account'),
  );

export const accountDeletionStateDecoder: Decoder<AccountDeletionState> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('ready'),
      step: accountDeletionStepDecoder,
      attempt: accountDeletionAttemptDecoder,
      notBefore: timestampDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('running'),
      step: accountDeletionStepDecoder,
      attempt: accountDeletionAttemptDecoder,
      leaseExpiresAt: timestampDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('retry-wait'),
      step: accountDeletionStepDecoder,
      attempt: accountDeletionAttemptDecoder,
      retryAt: timestampDecoder,
      failureCode: accountDeletionFailureCodeDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('terminal-failure'),
      step: accountDeletionStepDecoder,
      attempt: accountDeletionAttemptDecoder,
      failureCode: accountDeletionFailureCodeDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('completed'),
      completedAt: timestampDecoder,
    }),
  );

export const accountDeletionOperationDecoder: Decoder<AccountDeletionOperation> =
  objectDecoder({
    operationId: accountDeletionOperationIdDecoder,
    accountId: accountIdDecoder,
    vaultId: vaultIdDecoder,
    revision: accountDeletionRevisionDecoder,
    state: accountDeletionStateDecoder,
    createdAt: timestampDecoder,
    updatedAt: timestampDecoder,
  });

export const accountDeletionStepReceiptDecoder: Decoder<AccountDeletionStepReceipt> =
  objectDecoder({
    operationId: accountDeletionOperationIdDecoder,
    step: accountDeletionStepDecoder,
    completedAt: timestampDecoder,
  });

export function parseAccountDeletionOperationId(
  input: unknown,
): AccountDeletionOperationId {
  return decodeOrThrow(
    accountDeletionOperationIdDecoder,
    input,
    'AccountDeletionOperationId',
  );
}

export function parseAccountDeletionFailureCode(
  input: unknown,
): AccountDeletionFailureCode {
  return decodeOrThrow(
    accountDeletionFailureCodeDecoder,
    input,
    'AccountDeletionFailureCode',
  );
}

export function parseAccountDeletionIdempotencyKey(
  input: unknown,
): AccountDeletionIdempotencyKey {
  return decodeOrThrow(
    accountDeletionIdempotencyKeyDecoder,
    input,
    'AccountDeletionIdempotencyKey',
  );
}

export function parseAccountDeletionCredentialHash(
  input: unknown,
): AccountDeletionCredentialHash {
  return decodeOrThrow(
    accountDeletionCredentialHashDecoder,
    input,
    'AccountDeletionCredentialHash',
  );
}

export function parseAccountDeletionContinuationSecret(
  input: unknown,
): AccountDeletionContinuationSecret {
  return decodeOrThrow(
    accountDeletionContinuationSecretDecoder,
    input,
    'AccountDeletionContinuationSecret',
  );
}

export function parseAccountDeletionContinuationToken(
  input: unknown,
): AccountDeletionContinuationToken {
  return decodeOrThrow(
    accountDeletionContinuationTokenDecoder,
    input,
    'AccountDeletionContinuationToken',
  );
}

export function createAccountDeletionContinuationToken(
  secret: AccountDeletionContinuationSecret,
  sequence: AccountDeletionContinuationSequence,
): AccountDeletionContinuationToken {
  return parseAccountDeletionContinuationToken(`ad1.${secret}.${sequence}`);
}

export function accountDeletionContinuationTokenParts(
  token: AccountDeletionContinuationToken,
): {
  readonly secret: AccountDeletionContinuationSecret;
  readonly sequence: AccountDeletionContinuationSequence;
} {
  const [, rawSecret, rawSequence] = token.split('.');
  return {
    secret: parseAccountDeletionContinuationSecret(rawSecret),
    sequence: decodeOrThrow(
      accountDeletionContinuationSequenceDecoder,
      Number(rawSequence),
      'AccountDeletionContinuationSequence',
    ),
  };
}

export function accountDeletionScope(
  context: AccountDeletionScope,
): AccountDeletionScope {
  return { accountId: context.accountId, vaultId: context.vaultId };
}
