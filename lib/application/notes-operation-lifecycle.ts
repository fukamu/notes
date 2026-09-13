import type { NotesScope } from '@/lib/application/notes-runtime';
import { assertNever } from '@/lib/shared/invariant';

export type NotesOperation = 'load' | 'save' | 'sync';

export type NotesOperationEpoch = {
  readonly kind: 'notes-operation-epoch';
  readonly value: number;
};

type CapturedNotesOperationScope = NotesScope;

export type NotesOperationLifecycle =
  | {
      readonly kind: 'stopped';
      readonly operationEpoch: NotesOperationEpoch;
      readonly scope: CapturedNotesOperationScope;
    }
  | {
      readonly kind: 'active';
      readonly operationEpoch: NotesOperationEpoch;
      readonly scope: CapturedNotesOperationScope;
    };

export type NotesOperationToken = {
  readonly operation: NotesOperation;
  readonly operationEpoch: NotesOperationEpoch;
  readonly scope: CapturedNotesOperationScope;
};

export type CaptureNotesOperationDecision =
  | { readonly kind: 'captured'; readonly token: NotesOperationToken }
  | {
      readonly kind: 'rejected';
      readonly operation: NotesOperation;
      readonly reason: 'lifecycle-stopped';
    };

export type ContinueNotesOperationDecision =
  | { readonly kind: 'accepted'; readonly operation: NotesOperation }
  | {
      readonly kind: 'rejected';
      readonly operation: NotesOperation;
      readonly reason:
        | 'lifecycle-stopped'
        | 'operation-epoch-changed'
        | 'scope-changed';
    };

/** Creates a fail-closed lifecycle; React composition explicitly activates it. */
export function createStoppedNotesOperationLifecycle(
  scope: NotesScope,
): NotesOperationLifecycle {
  return {
    kind: 'stopped',
    operationEpoch: { kind: 'notes-operation-epoch', value: 0 },
    scope: captureScope(scope),
  };
}

/** Starts a new generation so completions captured by an earlier mount fail. */
export function activateNotesOperationLifecycle(
  lifecycle: NotesOperationLifecycle,
  scope: NotesScope,
): NotesOperationLifecycle {
  const operationEpochValue = lifecycle.operationEpoch.value + 1;
  if (!Number.isSafeInteger(operationEpochValue)) {
    throw new Error('Notes operation epoch exhausted');
  }
  return {
    kind: 'active',
    operationEpoch: {
      kind: 'notes-operation-epoch',
      value: operationEpochValue,
    },
    scope: captureScope(scope),
  };
}

export function stopNotesOperationLifecycle(
  lifecycle: NotesOperationLifecycle,
): NotesOperationLifecycle {
  return {
    kind: 'stopped',
    operationEpoch: lifecycle.operationEpoch,
    scope: lifecycle.scope,
  };
}

export function captureNotesOperation(
  lifecycle: NotesOperationLifecycle,
  operation: NotesOperation,
): CaptureNotesOperationDecision {
  switch (lifecycle.kind) {
    case 'stopped':
      return { kind: 'rejected', operation, reason: 'lifecycle-stopped' };
    case 'active':
      return {
        kind: 'captured',
        token: {
          operation,
          operationEpoch: lifecycle.operationEpoch,
          scope: lifecycle.scope,
        },
      };
    default:
      return assertNever(lifecycle, 'Unsupported notes operation lifecycle');
  }
}

/**
 * Makes the security decision without consulting React, storage, time, or the
 * network. The current trusted composition scope is authoritative.
 */
export function decideNotesOperationContinuation(
  lifecycle: NotesOperationLifecycle,
  token: NotesOperationToken,
): ContinueNotesOperationDecision {
  if (lifecycle.kind === 'stopped') {
    return {
      kind: 'rejected',
      operation: token.operation,
      reason: 'lifecycle-stopped',
    };
  }
  if (!sameScope(lifecycle.scope, token.scope)) {
    return {
      kind: 'rejected',
      operation: token.operation,
      reason: 'scope-changed',
    };
  }
  if (lifecycle.operationEpoch.value !== token.operationEpoch.value) {
    return {
      kind: 'rejected',
      operation: token.operation,
      reason: 'operation-epoch-changed',
    };
  }
  return { kind: 'accepted', operation: token.operation };
}

function captureScope(scope: NotesScope): CapturedNotesOperationScope {
  switch (scope.kind) {
    case 'legacy':
      return {
        kind: 'legacy',
        databaseName: scope.databaseName,
        syncEndpoint: scope.syncEndpoint,
      };
    case 'vault':
      return {
        kind: 'vault',
        accountId: scope.accountId,
        vaultId: scope.vaultId,
        sessionId: scope.sessionId,
        sessionEpoch: scope.sessionEpoch,
      };
    default:
      return assertNever(scope, 'Unsupported notes operation scope');
  }
}

function sameScope(
  current: CapturedNotesOperationScope,
  captured: CapturedNotesOperationScope,
): boolean {
  switch (current.kind) {
    case 'legacy':
      return (
        captured.kind === 'legacy' &&
        current.databaseName === captured.databaseName &&
        current.syncEndpoint === captured.syncEndpoint
      );
    case 'vault':
      return (
        captured.kind === 'vault' &&
        current.accountId === captured.accountId &&
        current.vaultId === captured.vaultId &&
        current.sessionId === captured.sessionId &&
        current.sessionEpoch === captured.sessionEpoch
      );
    default:
      return assertNever(current, 'Unsupported captured notes scope');
  }
}
