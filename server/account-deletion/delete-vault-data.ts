import type { EncryptedObjectMetadataPurgePort } from '../encrypted-object/public';
import type { VaultLiveDataPurgePort } from '../vault-content/public';
import type { AccountDeletionStepResult } from './core';
import {
  evaluateEncryptedMetadataPurge,
  evaluateVaultLiveDataDelete,
  planDeleteVaultDataStep,
  type DeleteVaultDataStepPlan,
} from './delete-vault-data-core';
import type { AccountDeletionSnapshot } from './public';

export type DeleteVaultDataExecutionResult =
  | Extract<DeleteVaultDataStepPlan, { kind: 'rejected' }>
  | {
      readonly kind: 'executed';
      readonly result: AccountDeletionStepResult;
    };

export async function executeDeleteVaultDataStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
  readonly encryptedObjects: EncryptedObjectMetadataPurgePort;
  readonly vaultContent: VaultLiveDataPurgePort;
}): Promise<DeleteVaultDataExecutionResult> {
  const plan = planDeleteVaultDataStep(input);
  if (plan.kind === 'rejected') return plan;

  let metadataResult:
    | Awaited<
        ReturnType<EncryptedObjectMetadataPurgePort['purgeVaultMetadata']>
      >
    | { readonly kind: 'unavailable' };
  try {
    metadataResult = await input.encryptedObjects.purgeVaultMetadata({
      scope: plan.scope,
      requestedAt: plan.requestedAt,
    });
  } catch {
    metadataResult = { kind: 'unavailable' };
  }
  const metadataDecision = evaluateEncryptedMetadataPurge(plan, metadataResult);
  if (metadataDecision.kind === 'complete') {
    return { kind: 'executed', result: metadataDecision.result };
  }

  let contentResult:
    | Awaited<ReturnType<VaultLiveDataPurgePort['purgeVaultLiveData']>>
    | { readonly kind: 'unavailable' };
  try {
    contentResult = await input.vaultContent.purgeVaultLiveData(plan.scope);
  } catch {
    contentResult = { kind: 'unavailable' };
  }
  return {
    kind: 'executed',
    result: evaluateVaultLiveDataDelete(plan, contentResult),
  };
}
