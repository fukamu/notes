import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { FullNetworkMapSnapshot } from '@/lib/graph/full-network-camera';

export type FullNetworkMapSession = Readonly<{
  scope: VaultNotesScope;
  read: () => FullNetworkMapSnapshot | null;
  write: (snapshot: FullNetworkMapSnapshot) => void;
  clear: () => void;
}>;

export function sameFullNetworkMapSessionScope(
  left: VaultNotesScope,
  right: VaultNotesScope,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

/**
 * Creates an in-memory map session owned by one Notes runtime composition.
 * Nothing is persisted to global storage, so destroying the runtime on logout
 * also destroys its camera and selection state.
 */
export function createFullNetworkMapSession(
  scope: VaultNotesScope,
): FullNetworkMapSession {
  let snapshot: FullNetworkMapSnapshot | null = null;
  return {
    scope,
    read: () => snapshot,
    write: (next) => {
      snapshot = next;
    },
    clear: () => {
      snapshot = null;
    },
  };
}
