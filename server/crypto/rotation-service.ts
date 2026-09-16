import type { KeyManagementPort } from './ports';
import {
  planDekRotationGenerated,
  planDekRotationPromotion,
  planDekRotationStart,
  type DekRotationOperation,
  type DekRotationOperationId,
  type DekRotationScope,
} from './rotation-core';
import type {
  DekRotationCommitResult,
  DekRotationRepository,
} from './rotation-ports';

export type DekRotationRunResult =
  | {
      readonly kind: 'pending';
      readonly operation: DekRotationOperation;
    }
  | {
      readonly kind: 'completed';
      readonly operation: DekRotationOperation;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'conflict' | 'invalid-state' | 'not-found';
    };

export type DekRotationService = {
  start(input: {
    readonly scope: DekRotationScope;
    readonly operationId: DekRotationOperationId;
    readonly requestedAt: number;
  }): Promise<DekRotationRunResult>;
  resume(input: {
    readonly scope: DekRotationScope;
    readonly operationId: DekRotationOperationId;
    readonly performedAt: number;
  }): Promise<DekRotationRunResult>;
};

export function createDekRotationService(input: {
  readonly repository: DekRotationRepository;
  readonly keyManagement: KeyManagementPort;
}): DekRotationService {
  return {
    async start(command) {
      const loaded = await input.repository.load(command.scope);
      if (loaded.kind === 'not-found') return rejected('not-found');
      const plan = planDekRotationStart({
        scope: command.scope,
        keyring: loaded.snapshot.keyring,
        ...(loaded.snapshot.operation === undefined
          ? {}
          : { current: loaded.snapshot.operation }),
        operationId: command.operationId,
        requestedAt: command.requestedAt,
      });
      if (plan.kind === 'replayed') return resultFor(plan.operation);
      if (plan.kind === 'rejected') return rejected('invalid-state');
      return commitResult(await input.repository.start(command.scope, plan));
    },

    async resume(command) {
      const loaded = await input.repository.load(command.scope);
      if (loaded.kind === 'not-found') return rejected('not-found');
      const operation = loaded.snapshot.operation;
      if (
        operation === undefined ||
        operation.operationId !== command.operationId
      ) {
        return rejected('not-found');
      }
      switch (operation.state.kind) {
        case 'generating': {
          const generated = await input.keyManagement.generateDataKey({
            vaultId: command.scope.vaultId,
            dekVersion: operation.targetVersion,
          });
          try {
            const plan = planDekRotationGenerated({
              operation,
              metadata: generated.metadata,
              generatedAt: command.performedAt,
            });
            if (plan.kind === 'rejected') return rejected('invalid-state');
            return commitResult(
              await input.repository.recordGenerated(
                command.scope,
                plan.transition,
              ),
            );
          } finally {
            generated.key.destroy();
          }
        }
        case 'promoting': {
          const plan = planDekRotationPromotion({
            operation,
            keyring: loaded.snapshot.keyring,
            completedAt: command.performedAt,
          });
          if (plan.kind === 'rejected') return rejected('invalid-state');
          return commitResult(
            await input.repository.promote(command.scope, plan.transition),
          );
        }
        case 'completed':
          return { kind: 'completed', operation };
      }
    },
  };
}

function commitResult(result: DekRotationCommitResult): DekRotationRunResult {
  switch (result.kind) {
    case 'applied':
    case 'replayed': {
      const operation = result.snapshot.operation;
      return operation === undefined
        ? rejected('conflict')
        : resultFor(operation);
    }
    case 'conflict':
      return rejected('conflict');
  }
}

function resultFor(operation: DekRotationOperation): DekRotationRunResult {
  return operation.state.kind === 'completed'
    ? { kind: 'completed', operation }
    : { kind: 'pending', operation };
}

function rejected(
  reason: Extract<DekRotationRunResult, { kind: 'rejected' }>['reason'],
): DekRotationRunResult {
  return { kind: 'rejected', reason };
}
