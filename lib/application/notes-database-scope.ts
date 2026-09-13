import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { LegacyNotesScope } from '@/lib/application/notes-runtime';
import type { AccountId, VaultId } from '@/lib/domain/identity';
import { assertNever } from '@/lib/shared/invariant';

export type VaultNotesDatabaseName =
  `fukamu-notes:v1:vault:${AccountId}:${VaultId}`;

export type NotesDatabaseName =
  | LegacyNotesScope['databaseName']
  | VaultNotesDatabaseName;

export type IndexedDbNotesScope = LegacyNotesScope | VaultNotesScope;

export type CloseNotesDatabaseResult =
  | { readonly kind: 'closed' }
  | { readonly kind: 'not-open' };

export type DeleteNotesDatabaseResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'failed';
      readonly reason: 'request-error' | 'request-threw';
    };

export function vaultNotesDatabaseName(
  scope: Pick<VaultNotesScope, 'accountId' | 'vaultId'>,
): VaultNotesDatabaseName {
  return `fukamu-notes:v1:vault:${scope.accountId}:${scope.vaultId}`;
}

export function notesDatabaseName(
  scope: IndexedDbNotesScope,
): NotesDatabaseName {
  switch (scope.kind) {
    case 'legacy':
      return scope.databaseName;
    case 'vault':
      return vaultNotesDatabaseName(scope);
    default:
      return assertNever(scope, 'Unsupported notes database scope');
  }
}
