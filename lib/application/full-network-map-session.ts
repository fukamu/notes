import {
  sameNotesScope,
  type NotesScope,
} from '@/lib/application/notes-runtime';
import type { FullNetworkMapSnapshot } from '@/lib/graph/full-network-camera';

export type FullNetworkMapSession = Readonly<{
  scope: NotesScope;
  read: () => FullNetworkMapSnapshot | null;
  write: (snapshot: FullNetworkMapSnapshot) => void;
  clear: () => void;
}>;

export function sameFullNetworkMapSessionScope(
  left: NotesScope,
  right: NotesScope,
): boolean {
  return sameNotesScope(left, right);
}

/**
 * Creates an in-memory map session owned by one Notes runtime composition.
 * Nothing is persisted to global storage, so destroying the runtime on logout
 * also destroys its camera and selection state.
 */
export function createFullNetworkMapSession(
  scope: NotesScope,
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
