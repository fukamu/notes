import type { VaultPrivateObjectPurgePort } from '../encrypted-object/public';
import type { AccountDeletionStepResult } from './core';
import {
  mapDeletePrivateObjectsStepResult,
  planDeletePrivateObjectsStep,
  type DeletePrivateObjectsEffectResult,
  type DeletePrivateObjectsStepPlan,
} from './delete-private-objects-core';
import type { AccountDeletionSnapshot } from './public';

export type DeletePrivateObjectsExecutionResult =
  | Extract<DeletePrivateObjectsStepPlan, { kind: 'rejected' }>
  | {
      readonly kind: 'executed';
      readonly result: AccountDeletionStepResult;
    };

export async function executeDeletePrivateObjectsStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
  readonly encryptedObjects: VaultPrivateObjectPurgePort;
}): Promise<DeletePrivateObjectsExecutionResult> {
  const plan = planDeletePrivateObjectsStep(input);
  if (plan.kind === 'rejected') return plan;

  let effect: DeletePrivateObjectsEffectResult;
  try {
    effect = await input.encryptedObjects.purgeVaultPrivateObjects({
      scope: plan.scope,
      attemptedAt: plan.attemptedAt,
    });
  } catch {
    effect = { kind: 'unavailable' };
  }
  return {
    kind: 'executed',
    result: mapDeletePrivateObjectsStepResult(plan, effect),
  };
}
