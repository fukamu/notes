import type {
  NotesLocation,
  NotesNavigationSnapshot,
} from '@/lib/application/navigation';
import type {
  ConnectionsCameraSnapshot,
  ConnectionsPoint,
} from '@/lib/graph/connections-viewport';
import type { CardId } from '@/lib/domain/id';

export type CompactCameraSnapshot = Readonly<{
  currentCardId: CardId;
  layoutRevision: number;
  scale: number;
  centerWorld: ConnectionsPoint;
}>;

export type NotesCameraBinding = Readonly<{
  entryId: number;
  activationId: number;
  currentCardId: CardId;
  cause: NotesNavigationSnapshot['cause'];
}>;

export type NotesCameraSession = Readonly<{
  bind: (binding: NotesCameraBinding) => NotesCameraPosition;
  discardEntries: (entryIds: readonly number[]) => void;
  replaceEntry: (
    entryId: number,
    previous: NotesLocation,
    next: NotesLocation,
  ) => void;
}>;

export type NotesCameraPosition = Readonly<{
  entryId: number;
  activationId: number;
  cause: NotesNavigationSnapshot['cause'];
  restoreViewportFocus: boolean;
  read: (layoutKey?: string) => ConnectionsCameraSnapshot | null;
  write: (snapshot: ConnectionsCameraSnapshot) => void;
  isActive: () => boolean;
}>;

function sameBinding(
  current: NotesNavigationSnapshot,
  binding: NotesCameraBinding,
): boolean {
  return (
    current.entryId === binding.entryId &&
    current.activationId === binding.activationId &&
    current.location.kind === 'connections' &&
    current.location.cardId === binding.currentCardId
  );
}

function cameraCardId(location: NotesLocation): CardId | null {
  return location.kind === 'empty' ? null : location.cardId;
}

export function createNotesCameraSession(
  getNavigationSnapshot: () => NotesNavigationSnapshot,
): NotesCameraSession {
  const entries = new Map<number, CompactCameraSnapshot>();
  let auxiliary: CompactCameraSnapshot | null = null;
  let latestReadyLayoutKey: string | null = null;
  let layoutRevision = 0;

  const acceptReadyLayout = (layoutKey: string): number | null => {
    if (layoutKey.length === 0) return null;
    if (latestReadyLayoutKey !== layoutKey) {
      latestReadyLayoutKey = layoutKey;
      layoutRevision += 1;
    }
    return layoutRevision;
  };

  return {
    bind: (binding) => ({
      entryId: binding.entryId,
      activationId: binding.activationId,
      cause: binding.cause,
      restoreViewportFocus: binding.cause === 'traverse',
      isActive: () => sameBinding(getNavigationSnapshot(), binding),
      read: (layoutKey) => {
        if (!layoutKey || !sameBinding(getNavigationSnapshot(), binding)) {
          return null;
        }
        const revision = acceptReadyLayout(layoutKey);
        if (revision === null) return null;
        const entrySnapshot = entries.get(binding.entryId) ?? null;
        const selected =
          binding.cause === 'traverse'
            ? entrySnapshot
            : binding.cause === 'tab'
              ? (entrySnapshot ?? auxiliary)
              : null;
        if (
          !selected ||
          selected.currentCardId !== binding.currentCardId ||
          selected.layoutRevision !== revision
        ) {
          return null;
        }
        return {
          currentCardId: selected.currentCardId,
          layoutKey,
          scale: selected.scale,
          centerWorld: selected.centerWorld,
        };
      },
      write: (snapshot) => {
        if (
          !sameBinding(getNavigationSnapshot(), binding) ||
          snapshot.currentCardId !== binding.currentCardId ||
          snapshot.layoutKey !== latestReadyLayoutKey ||
          layoutRevision === 0
        ) {
          return;
        }
        const compact: CompactCameraSnapshot = {
          currentCardId: snapshot.currentCardId,
          layoutRevision,
          scale: snapshot.scale,
          centerWorld: snapshot.centerWorld,
        };
        entries.set(binding.entryId, compact);
        auxiliary = compact;
      },
    }),
    discardEntries: (entryIds) => {
      for (const entryId of entryIds) entries.delete(entryId);
    },
    replaceEntry: (entryId, previous, next) => {
      if (cameraCardId(previous) === cameraCardId(next)) return;
      entries.delete(entryId);
      if (auxiliary?.currentCardId === cameraCardId(previous)) auxiliary = null;
    },
  };
}
