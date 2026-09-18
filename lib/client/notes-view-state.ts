import type {
  CardScrollSnapshot,
  NotesViewStatePorts,
  ViewStateSlot,
} from '@/lib/application/notes-view-state';
import type { HistoryAnchor } from '@/lib/application/history-window';
import type { NotesCameraPosition } from '@/lib/application/navigation-camera-session';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsCameraSnapshot } from '@/lib/graph/connections-viewport';

function createCurrentCardSlot<T extends Readonly<{ currentCardId: CardId }>>(
  currentCardId: CardId | null,
): ViewStateSlot<T> {
  let snapshot: T | null = null;
  return {
    read: () => snapshot,
    write: (next) => {
      if (currentCardId === next.currentCardId) snapshot = next;
    },
  };
}

export function createNotesViewStatePorts(
  currentCardId: CardId | null,
  connectionsPosition?: NotesCameraPosition,
): NotesViewStatePorts {
  return {
    body: createCurrentCardSlot<CardScrollSnapshot>(currentCardId),
    history: createCurrentCardSlot<HistoryAnchor>(currentCardId),
    connections:
      connectionsPosition ?? createLegacyConnectionsPosition(currentCardId),
  };
}

function createLegacyConnectionsPosition(
  currentCardId: CardId | null,
): NotesCameraPosition {
  const slot = createCurrentCardSlot<ConnectionsCameraSnapshot>(currentCardId);
  return {
    entryId: 0,
    activationId: 0,
    cause: 'initial',
    restoreViewportFocus: false,
    isActive: () => true,
    read: (layoutKey) => {
      const snapshot = slot.read();
      return !layoutKey || snapshot?.layoutKey === layoutKey ? snapshot : null;
    },
    write: slot.write,
  };
}
