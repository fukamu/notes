import {
  BoundaryDecodeError,
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
} from '../../lib/codec/core';
import { assertNever } from '../../lib/shared/invariant';
import type { D1DatabaseBinding } from '../../db/d1-types';
import {
  isInitialAccountDeletionOperation,
  isValidAccountDeletionSnapshot,
  isValidAccountDeletionTransition,
  sameAccountDeletionOperation,
  sameAccountDeletionReceipt,
} from './core';
import type {
  AccountDeletionCommitResult,
  AccountDeletionCreateResult,
  AccountDeletionOperation,
  AccountDeletionRepository,
  AccountDeletionScope,
  AccountDeletionSnapshot,
  AccountDeletionState,
  AccountDeletionStepReceipt,
  AccountDeletionTransition,
} from './public';
import {
  accountDeletionOperationRowDecoder,
  accountDeletionReceiptRowDecoder,
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

export class D1AccountDeletionRepository implements AccountDeletionRepository {
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
