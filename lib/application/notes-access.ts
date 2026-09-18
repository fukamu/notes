import type {
  AccountId,
  SessionEpoch,
  SessionId,
  VaultContext,
  VaultId,
} from '@/lib/domain/identity';
import { assertNever } from '@/lib/shared/invariant';

export type NotesAccess =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'authenticated'; readonly context: VaultContext };

export type VaultNotesScope = {
  readonly kind: 'vault';
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly sessionId: SessionId;
  readonly sessionEpoch: SessionEpoch;
};

export type NotesRuntimeLaunchPlan =
  | { readonly kind: 'do-not-start'; readonly reason: 'anonymous' }
  | { readonly kind: 'start'; readonly scope: VaultNotesScope };

export function planNotesRuntimeLaunch(
  access: NotesAccess,
): NotesRuntimeLaunchPlan {
  switch (access.kind) {
    case 'anonymous':
      return { kind: 'do-not-start', reason: 'anonymous' };
    case 'authenticated':
      return { kind: 'start', scope: vaultNotesScope(access.context) };
    default:
      return assertNever(access, 'Unsupported notes access');
  }
}

export function vaultNotesScope(context: VaultContext): VaultNotesScope {
  return { kind: 'vault', ...context };
}

export function vaultContextFromNotesScope(
  scope: VaultNotesScope,
): VaultContext {
  return {
    accountId: scope.accountId,
    vaultId: scope.vaultId,
    sessionId: scope.sessionId,
    sessionEpoch: scope.sessionEpoch,
  };
}

export function scopeMatchesVaultContext(
  scope: VaultNotesScope,
  context: VaultContext,
): boolean {
  return (
    scope.accountId === context.accountId &&
    scope.vaultId === context.vaultId &&
    scope.sessionId === context.sessionId &&
    scope.sessionEpoch === context.sessionEpoch
  );
}
