import type { AccountLiveStateFinalizationPort } from '../control-plane/public';
import type { VaultWrappedKeyFinalizationPort } from '../crypto/public';
import type { VaultPrivateObjectDeletionBarrierPort } from '../encrypted-object/public';
import type { AccountDeletionStepResult } from './core';
import {
  evaluateAccountLiveStateFinalization,
  evaluatePrivateObjectReconfirmation,
  evaluateWrappedKeyFinalization,
  planFinalizeAccountStep,
  type AccountLiveStateFinalizationEffect,
  type FinalizeAccountStepPlan,
  type PrivateObjectReconfirmationEffect,
  type WrappedKeyFinalizationEffect,
} from './finalize-account-core';
import type { AccountDeletionSnapshot } from './public';

export type FinalizeAccountExecutionResult =
  | Extract<FinalizeAccountStepPlan, { kind: 'rejected' }>
  | {
      readonly kind: 'executed';
      readonly result: AccountDeletionStepResult;
    };

export async function executeFinalizeAccountStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
  readonly privateObjects: VaultPrivateObjectDeletionBarrierPort;
  readonly wrappedKeys: VaultWrappedKeyFinalizationPort;
  readonly controlPlane: AccountLiveStateFinalizationPort;
}): Promise<FinalizeAccountExecutionResult> {
  const plan = planFinalizeAccountStep(input);
  if (plan.kind === 'rejected') return plan;

  let privateObjectEffect: PrivateObjectReconfirmationEffect;
  try {
    privateObjectEffect =
      await input.privateObjects.confirmVaultPrivateObjectDeletion(plan.scope);
  } catch {
    privateObjectEffect = { kind: 'unavailable' };
  }
  const privateObjectDecision = evaluatePrivateObjectReconfirmation(
    plan,
    privateObjectEffect,
  );
  if (privateObjectDecision.kind === 'complete') {
    return { kind: 'executed', result: privateObjectDecision.result };
  }

  let wrappedKeyEffect: WrappedKeyFinalizationEffect;
  try {
    wrappedKeyEffect = await input.wrappedKeys.finalizeVaultWrappedKeys(
      plan.scope,
    );
  } catch {
    wrappedKeyEffect = { kind: 'unavailable' };
  }
  const wrappedKeyDecision = evaluateWrappedKeyFinalization(
    plan,
    wrappedKeyEffect,
  );
  if (wrappedKeyDecision.kind === 'complete') {
    return { kind: 'executed', result: wrappedKeyDecision.result };
  }

  let liveStateEffect: AccountLiveStateFinalizationEffect;
  try {
    liveStateEffect = await input.controlPlane.finalizeAccountLiveState(
      plan.scope,
    );
  } catch {
    liveStateEffect = { kind: 'unavailable' };
  }
  return {
    kind: 'executed',
    result: evaluateAccountLiveStateFinalization(plan, liveStateEffect),
  };
}
