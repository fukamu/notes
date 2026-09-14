import {
  BoundaryDecodeError,
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import { assertNever } from '../../lib/shared/invariant';
import type { D1DatabaseBinding } from '../../db/d1-types';
import {
  isInitialAccountDeletionOperation,
  isValidAccountDeletionSnapshot,
  isValidAccountDeletionTransition,
  sameAccountDeletionOperation,
  sameAccountDeletionReceipt,
} from './core';
import {
  isValidAccountDeletionContinuation,
  planAccountDeletionContinuationConsume,
} from './http-core';
import type {
  AccountDeletionAccessConsumeResult,
  AccountDeletionAccessRepository,
  AccountDeletionAccessStartResult,
  AccountDeletionAuthorizedSnapshot,
  AccountDeletionContinuation,
  AccountDeletionCredentialHash,
  AccountDeletionCommitResult,
  AccountDeletionCreateResult,
  AccountDeletionOperation,
  AccountDeletionRepository,
  AccountDeletionScope,
  AccountDeletionSnapshot,
  AccountDeletionState,
  AccountDeletionStepReceipt,
  AccountDeletionTransition,
  AccountDeletionContinuationSequence,
} from './public';
import {
  accountDeletionContinuationRowDecoder,
  accountDeletionOperationRowDecoder,
  accountDeletionReceiptRowDecoder,
  mapAccountDeletionContinuationRow,
  mapAccountDeletionOperationRow,
  mapAccountDeletionReceiptRow,
} from './records';

const operationColumns = `operation_id, account_id, vault_id, revision, state,
  current_step, attempt, not_before, lease_expires_at, failure_code,
  created_at, updated_at, completed_at`;

const receiptRowsDecoder = objectDecoder(
  {
    results: arrayDecoder(accountDeletionReceiptRowDecoder, {
      maxLength: 5,
      uniqueBy: (row) => row.step,
    }),
  },
  { unknownFields: 'allow' },
);

const continuationColumns = `operation_id, idempotency_key_hash, secret_hash,
  sequence, expires_at, created_at, updated_at`;

export class D1AccountDeletionRepository
  implements AccountDeletionRepository, AccountDeletionAccessRepository
{
  constructor(private readonly database: D1DatabaseBinding) {}

  async findByOwner(
    scope: AccountDeletionScope,
  ): Promise<AccountDeletionSnapshot | undefined> {
    const rawOperation: unknown = await this.database
      .prepare(
        `SELECT ${operationColumns} FROM account_deletion_operations
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(scope.accountId, scope.vaultId)
      .first();
    if (rawOperation === null) return undefined;
    const operation = mapAccountDeletionOperationRow(
      decodeOrThrow(
        accountDeletionOperationRowDecoder,
        rawOperation,
        'D1 account deletion operation row',
      ),
    );
    const rawReceipts: unknown = await this.database
      .prepare(
        `SELECT receipt.operation_id, receipt.step, receipt.completed_at
         FROM account_deletion_step_receipts receipt
         JOIN account_deletion_operations operation
           ON operation.operation_id = receipt.operation_id
         WHERE receipt.operation_id = ?
           AND operation.account_id = ? AND operation.vault_id = ?
         ORDER BY CASE receipt.step
           WHEN 'revoke-sessions' THEN 1
           WHEN 'cancel-subscription' THEN 2
           WHEN 'delete-vault-data' THEN 3
           WHEN 'delete-private-objects' THEN 4
           WHEN 'finalize-account' THEN 5
         END ASC`,
      )
      .bind(operation.operationId, scope.accountId, scope.vaultId)
      .all();
    const decodedReceipts = decodeOrThrow(
      receiptRowsDecoder,
      rawReceipts,
      'D1 account deletion receipt rows',
    );
    const snapshot: AccountDeletionSnapshot = {
      operation,
      receipts: decodedReceipts.results.map(mapAccountDeletionReceiptRow),
    };
    if (!isValidAccountDeletionSnapshot(snapshot)) {
      throw new BoundaryDecodeError('D1 account deletion snapshot', [
        { path: [], reason: 'operation and receipt sequence are inconsistent' },
      ]);
    }
    return snapshot;
  }

  async create(
    operation: AccountDeletionOperation,
  ): Promise<AccountDeletionCreateResult> {
    if (!isInitialAccountDeletionOperation(operation)) {
      return { kind: 'rejected', reason: 'invalid-operation' };
    }
    try {
      await this.database
        .prepare(
          `INSERT INTO account_deletion_operations(${operationColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...operationBindings(operation))
        .run();
      return {
        kind: 'created',
        snapshot: { operation, receipts: [] },
      };
    } catch (error: unknown) {
      const existing = await this.findByOwner(operation);
      if (existing !== undefined) {
        return { kind: 'existing', snapshot: existing };
      }
      throw error;
    }
  }

  async startWithContinuation(input: {
    readonly operation: AccountDeletionOperation;
    readonly continuation: AccountDeletionContinuation;
  }): Promise<AccountDeletionAccessStartResult> {
    if (
      !isInitialAccountDeletionOperation(input.operation) ||
      !isValidAccountDeletionContinuation(input.continuation) ||
      input.continuation.operationId !== input.operation.operationId ||
      input.continuation.createdAt !== input.operation.createdAt
    ) {
      return { kind: 'rejected', reason: 'invalid-start' };
    }
    try {
      const results = await this.database.batch([
        operationInsert(this.database, input.operation),
        this.database
          .prepare(
            `INSERT INTO account_deletion_continuations(${continuationColumns})
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(...continuationBindings(input.continuation)),
      ]);
      if (results.some((result) => result.meta.changes !== 1)) {
        throw new BoundaryDecodeError('D1 account deletion start', [
          { path: [], reason: 'operation and continuation were not created' },
        ]);
      }
      return {
        kind: 'created',
        snapshot: { operation: input.operation, receipts: [] },
        continuation: input.continuation,
      };
    } catch (error: unknown) {
      const existing = await this.findByOwner(input.operation);
      if (existing === undefined) throw error;
      const continuation = await this.findContinuationByOperation(
        existing.operation.operationId,
      );
      if (continuation === undefined) throw error;
      if (
        continuation.idempotencyKeyHash !==
          input.continuation.idempotencyKeyHash ||
        continuation.secretHash !== input.continuation.secretHash
      ) {
        return { kind: 'rejected', reason: 'credential-conflict' };
      }
      const updatedAt = Math.max(
        continuation.updatedAt,
        input.continuation.createdAt,
      );
      if (input.continuation.expiresAt > continuation.expiresAt) {
        await this.database
          .prepare(
            `UPDATE account_deletion_continuations
             SET expires_at = ?, updated_at = ?
             WHERE operation_id = ? AND idempotency_key_hash = ?
               AND secret_hash = ? AND sequence = ?`,
          )
          .bind(
            input.continuation.expiresAt,
            updatedAt,
            continuation.operationId,
            continuation.idempotencyKeyHash,
            continuation.secretHash,
            continuation.sequence,
          )
          .run();
      }
      const refreshed = await this.findContinuationByOperation(
        existing.operation.operationId,
      );
      if (refreshed === undefined) throw error;
      return {
        kind: 'existing',
        snapshot: existing,
        continuation: refreshed,
      };
    }
  }

  async consumeContinuation(input: {
    readonly secretHash: AccountDeletionCredentialHash;
    readonly sequence: AccountDeletionContinuationSequence;
    readonly consumedAt: number;
  }): Promise<AccountDeletionAccessConsumeResult> {
    const current = await this.findContinuationBySecretHash(input.secretHash);
    if (current === undefined) {
      return { kind: 'rejected', reason: 'invalid-capability' };
    }
    const plan = planAccountDeletionContinuationConsume({
      continuation: current,
      presentedSequence: input.sequence,
      consumedAt: input.consumedAt,
    });
    if (plan.kind === 'rejected') {
      return {
        kind: 'rejected',
        reason: plan.reason === 'expired' ? 'expired' : 'invalid-capability',
      };
    }
    if (plan.kind === 'replay') {
      return {
        kind: 'replayed',
        ...(await this.authorizedSnapshot(current)),
      };
    }

    const result = await this.database
      .prepare(
        `UPDATE account_deletion_continuations
         SET sequence = ?, updated_at = ?
         WHERE operation_id = ? AND secret_hash = ? AND sequence = ?
           AND expires_at > ?`,
      )
      .bind(
        plan.next.sequence,
        plan.next.updatedAt,
        current.operationId,
        current.secretHash,
        current.sequence,
        input.consumedAt,
      )
      .run();
    const persisted = await this.findContinuationBySecretHash(input.secretHash);
    if (persisted === undefined) {
      return { kind: 'rejected', reason: 'invalid-capability' };
    }
    if (result.meta.changes === 1) {
      return {
        kind: 'consumed',
        ...(await this.authorizedSnapshot(persisted)),
      };
    }
    const retryPlan = planAccountDeletionContinuationConsume({
      continuation: persisted,
      presentedSequence: input.sequence,
      consumedAt: input.consumedAt,
    });
    return retryPlan.kind === 'replay'
      ? {
          kind: 'replayed',
          ...(await this.authorizedSnapshot(persisted)),
        }
      : {
          kind: 'rejected',
          reason:
            retryPlan.kind === 'rejected' && retryPlan.reason === 'expired'
              ? 'expired'
              : 'invalid-capability',
        };
  }

  async commit(
    scope: AccountDeletionScope,
    transition: AccountDeletionTransition,
  ): Promise<AccountDeletionCommitResult> {
    if (!isValidAccountDeletionTransition(scope, transition)) {
      return { kind: 'rejected', reason: 'invalid-transition' };
    }
    const update = this.database
      .prepare(
        `UPDATE account_deletion_operations SET
          revision = ?, state = ?, current_step = ?, attempt = ?,
          not_before = ?, lease_expires_at = ?, failure_code = ?,
          updated_at = ?, completed_at = ?
         WHERE operation_id = ? AND account_id = ? AND vault_id = ?
           AND revision = ?`,
      )
      .bind(
        ...mutableOperationBindings(transition.next),
        transition.current.operationId,
        scope.accountId,
        scope.vaultId,
        transition.current.revision,
      );
    const statements = transition.receipt
      ? [update, receiptInsert(this.database, transition.receipt)]
      : [update];
    const results = await this.database.batch(statements);
    const persisted = await this.findByOwner(scope);
    if (results[0]?.meta.changes === 1) {
      if (persisted === undefined) {
        throw new BoundaryDecodeError('D1 account deletion commit', [
          { path: [], reason: 'applied operation could not be reloaded' },
        ]);
      }
      return { kind: 'applied', snapshot: persisted };
    }
    if (
      persisted !== undefined &&
      sameAccountDeletionOperation(persisted.operation, transition.next) &&
      receiptWasPersisted(persisted, transition.receipt)
    ) {
      return { kind: 'replayed', snapshot: persisted };
    }
    return { kind: 'conflict', current: persisted };
  }

  private async findContinuationByOperation(
    operationId: AccountDeletionOperation['operationId'],
  ): Promise<AccountDeletionContinuation | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${continuationColumns} FROM account_deletion_continuations
         WHERE operation_id = ?`,
      )
      .bind(operationId)
      .first();
    return this.decodeContinuation(raw);
  }

  private async findContinuationBySecretHash(
    secretHash: AccountDeletionCredentialHash,
  ): Promise<AccountDeletionContinuation | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${continuationColumns} FROM account_deletion_continuations
         WHERE secret_hash = ?`,
      )
      .bind(secretHash)
      .first();
    return this.decodeContinuation(raw);
  }

  private decodeContinuation(
    raw: unknown,
  ): AccountDeletionContinuation | undefined {
    if (raw === null) return undefined;
    const continuation = mapAccountDeletionContinuationRow(
      decodeOrThrow(
        accountDeletionContinuationRowDecoder,
        raw,
        'D1 account deletion continuation row',
      ),
    );
    if (!isValidAccountDeletionContinuation(continuation)) {
      throw new BoundaryDecodeError('D1 account deletion continuation row', [
        { path: [], reason: 'continuation timeline is inconsistent' },
      ]);
    }
    return continuation;
  }

  private async authorizedSnapshot(
    continuation: AccountDeletionContinuation,
  ): Promise<AccountDeletionAuthorizedSnapshot> {
    const rawOperation: unknown = await this.database
      .prepare(
        `SELECT account_id, vault_id FROM account_deletion_operations
         WHERE operation_id = ?`,
      )
      .bind(continuation.operationId)
      .first();
    const scope = decodeOrThrow(
      objectDecoder({ account_id: accountIdDecoder, vault_id: vaultIdDecoder }),
      rawOperation,
      'D1 account deletion continuation owner',
    );
    const snapshot = await this.findByOwner({
      accountId: scope.account_id,
      vaultId: scope.vault_id,
    });
    if (
      snapshot === undefined ||
      snapshot.operation.operationId !== continuation.operationId
    ) {
      throw new BoundaryDecodeError('D1 account deletion continuation', [
        { path: ['operationId'], reason: 'operation scope is inconsistent' },
      ]);
    }
    return { snapshot, continuation };
  }
}

function operationInsert(
  database: D1DatabaseBinding,
  operation: AccountDeletionOperation,
) {
  return database
    .prepare(
      `INSERT INTO account_deletion_operations(${operationColumns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...operationBindings(operation));
}

function receiptInsert(
  database: D1DatabaseBinding,
  receipt: AccountDeletionStepReceipt,
) {
  return database
    .prepare(
      `INSERT INTO account_deletion_step_receipts(
        operation_id, step, completed_at
      ) SELECT ?, ?, ? WHERE changes() = 1`,
    )
    .bind(receipt.operationId, receipt.step, receipt.completedAt);
}

function continuationBindings(
  continuation: AccountDeletionContinuation,
): readonly unknown[] {
  return [
    continuation.operationId,
    continuation.idempotencyKeyHash,
    continuation.secretHash,
    continuation.sequence,
    continuation.expiresAt,
    continuation.createdAt,
    continuation.updatedAt,
  ];
}

function receiptWasPersisted(
  snapshot: AccountDeletionSnapshot,
  expected: AccountDeletionStepReceipt | undefined,
): boolean {
  if (expected === undefined) return true;
  return snapshot.receipts.some((receipt) =>
    sameAccountDeletionReceipt(receipt, expected),
  );
}

function operationBindings(
  operation: AccountDeletionOperation,
): readonly unknown[] {
  const state = stateBindings(operation.state);
  return [
    operation.operationId,
    operation.accountId,
    operation.vaultId,
    operation.revision,
    ...state,
    operation.createdAt,
    operation.updatedAt,
    completedAt(operation.state),
  ];
}

function mutableOperationBindings(
  operation: AccountDeletionOperation,
): readonly unknown[] {
  const state = stateBindings(operation.state);
  return [
    operation.revision,
    ...state,
    operation.updatedAt,
    completedAt(operation.state),
  ];
}

function stateBindings(state: AccountDeletionState): readonly unknown[] {
  switch (state.kind) {
    case 'ready':
      return [
        state.kind,
        state.step,
        state.attempt,
        state.notBefore,
        null,
        null,
      ];
    case 'running':
      return [
        state.kind,
        state.step,
        state.attempt,
        null,
        state.leaseExpiresAt,
        null,
      ];
    case 'retry-wait':
      return [
        state.kind,
        state.step,
        state.attempt,
        state.retryAt,
        null,
        state.failureCode,
      ];
    case 'terminal-failure':
      return [
        state.kind,
        state.step,
        state.attempt,
        null,
        null,
        state.failureCode,
      ];
    case 'completed':
      return [state.kind, null, 0, null, null, null];
    default:
      return assertNever(state, 'Unsupported account deletion state');
  }
}

function completedAt(state: AccountDeletionState): number | null {
  return state.kind === 'completed' ? state.completedAt : null;
}
