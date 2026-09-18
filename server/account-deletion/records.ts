import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import {
  accountDeletionAttemptDecoder,
  accountDeletionContinuationSequenceDecoder,
  accountDeletionCredentialHashDecoder,
  accountDeletionFailureCodeDecoder,
  accountDeletionOperationDecoder,
  accountDeletionOperationIdDecoder,
  accountDeletionRevisionDecoder,
  accountDeletionStepDecoder,
  accountDeletionStepReceiptDecoder,
  type AccountDeletionOperation,
  type AccountDeletionContinuation,
  type AccountDeletionState,
  type AccountDeletionStepReceipt,
} from './public';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const accountDeletionRowStateDecoder = unionDecoder(
  literalDecoder('ready'),
  literalDecoder('running'),
  literalDecoder('retry-wait'),
  literalDecoder('terminal-failure'),
  literalDecoder('completed'),
);

export const accountDeletionOperationRowDecoder = objectDecoder({
  operation_id: accountDeletionOperationIdDecoder,
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  revision: accountDeletionRevisionDecoder,
  state: accountDeletionRowStateDecoder,
  current_step: nullableDecoder(accountDeletionStepDecoder),
  attempt: accountDeletionAttemptDecoder,
  not_before: nullableDecoder(timestampDecoder),
  lease_expires_at: nullableDecoder(timestampDecoder),
  failure_code: nullableDecoder(accountDeletionFailureCodeDecoder),
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
  completed_at: nullableDecoder(timestampDecoder),
});

export const accountDeletionReceiptRowDecoder = objectDecoder({
  operation_id: accountDeletionOperationIdDecoder,
  step: accountDeletionStepDecoder,
  completed_at: timestampDecoder,
});

export const accountDeletionContinuationRowDecoder = objectDecoder({
  operation_id: accountDeletionOperationIdDecoder,
  idempotency_key_hash: accountDeletionCredentialHashDecoder,
  secret_hash: accountDeletionCredentialHashDecoder,
  sequence: accountDeletionContinuationSequenceDecoder,
  expires_at: timestampDecoder,
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
});

export type AccountDeletionOperationRow = InferDecoder<
  typeof accountDeletionOperationRowDecoder
>;
export type AccountDeletionReceiptRow = InferDecoder<
  typeof accountDeletionReceiptRowDecoder
>;
export type AccountDeletionContinuationRow = InferDecoder<
  typeof accountDeletionContinuationRowDecoder
>;

export function mapAccountDeletionOperationRow(
  row: AccountDeletionOperationRow,
): AccountDeletionOperation {
  let state: AccountDeletionState;
  switch (row.state) {
    case 'ready':
      if (
        row.current_step === null ||
        row.not_before === null ||
        row.lease_expires_at !== null ||
        row.failure_code !== null ||
        row.completed_at !== null
      ) {
        return invalidOperationRow('invalid ready state');
      }
      state = {
        kind: 'ready',
        step: row.current_step,
        attempt: row.attempt,
        notBefore: row.not_before,
      };
      break;
    case 'running':
      if (
        row.current_step === null ||
        row.not_before !== null ||
        row.lease_expires_at === null ||
        row.failure_code !== null ||
        row.completed_at !== null
      ) {
        return invalidOperationRow('invalid running state');
      }
      state = {
        kind: 'running',
        step: row.current_step,
        attempt: row.attempt,
        leaseExpiresAt: row.lease_expires_at,
      };
      break;
    case 'retry-wait':
      if (
        row.current_step === null ||
        row.not_before === null ||
        row.lease_expires_at !== null ||
        row.failure_code === null ||
        row.completed_at !== null
      ) {
        return invalidOperationRow('invalid retry state');
      }
      state = {
        kind: 'retry-wait',
        step: row.current_step,
        attempt: row.attempt,
        retryAt: row.not_before,
        failureCode: row.failure_code,
      };
      break;
    case 'terminal-failure':
      if (
        row.current_step === null ||
        row.not_before !== null ||
        row.lease_expires_at !== null ||
        row.failure_code === null ||
        row.completed_at !== null
      ) {
        return invalidOperationRow('invalid terminal failure state');
      }
      state = {
        kind: 'terminal-failure',
        step: row.current_step,
        attempt: row.attempt,
        failureCode: row.failure_code,
      };
      break;
    case 'completed':
      if (
        row.current_step !== null ||
        row.attempt !== 0 ||
        row.not_before !== null ||
        row.lease_expires_at !== null ||
        row.failure_code !== null ||
        row.completed_at === null
      ) {
        return invalidOperationRow('invalid completed state');
      }
      state = { kind: 'completed', completedAt: row.completed_at };
      break;
  }

  const candidate: unknown = {
    operationId: row.operation_id,
    accountId: row.account_id,
    vaultId: row.vault_id,
    revision: row.revision,
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const decoded = accountDeletionOperationDecoder.decode(candidate);
  if (!decoded.ok) {
    throw new BoundaryDecodeError(
      'D1 account deletion operation row',
      decoded.issues,
    );
  }
  return decoded.value;
}

export function mapAccountDeletionReceiptRow(
  row: AccountDeletionReceiptRow,
): AccountDeletionStepReceipt {
  const candidate: unknown = {
    operationId: row.operation_id,
    step: row.step,
    completedAt: row.completed_at,
  };
  const decoded = accountDeletionStepReceiptDecoder.decode(candidate);
  if (!decoded.ok) {
    throw new BoundaryDecodeError(
      'D1 account deletion receipt row',
      decoded.issues,
    );
  }
  return decoded.value;
}

export function mapAccountDeletionContinuationRow(
  row: AccountDeletionContinuationRow,
): AccountDeletionContinuation {
  return {
    operationId: row.operation_id,
    idempotencyKeyHash: row.idempotency_key_hash,
    secretHash: row.secret_hash,
    sequence: row.sequence,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function invalidOperationRow(reason: string): never {
  throw new BoundaryDecodeError('D1 account deletion operation row', [
    { path: ['state'], reason },
  ]);
}
