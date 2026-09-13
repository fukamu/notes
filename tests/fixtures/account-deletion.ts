import {
  parseAccountDeletionFailureCode,
  parseAccountDeletionOperationId,
  type AccountDeletionOperation,
  type AccountDeletionScope,
} from '@/server/account-deletion/public';
import { sessionFixtureIds } from './session';

export const accountDeletionFixtureIds = {
  operationA: parseAccountDeletionOperationId(
    '01991f20-61d2-7000-8000-000000000801',
  ),
  operationB: parseAccountDeletionOperationId(
    '01991f20-61d2-7000-8000-000000000802',
  ),
} as const;

export const accountDeletionFailureCodes = {
  temporary: parseAccountDeletionFailureCode('temporary-storage-failure'),
  permanent: parseAccountDeletionFailureCode('provider-refused'),
} as const;

export function accountDeletionScopeFixture(
  owner: 'a' | 'b' = 'a',
): AccountDeletionScope {
  return owner === 'a'
    ? {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
      }
    : {
        accountId: sessionFixtureIds.otherAccountId,
        vaultId: sessionFixtureIds.otherVaultId,
      };
}

export function requireDeletionOperation(
  plan:
    | {
        readonly kind: 'accepted';
        readonly operation: AccountDeletionOperation;
      }
    | { readonly kind: 'rejected' },
): AccountDeletionOperation {
  if (plan.kind !== 'accepted') {
    throw new Error('invalid account deletion fixture');
  }
  return plan.operation;
}
