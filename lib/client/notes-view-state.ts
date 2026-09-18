import type {
  CardScrollSnapshot,
  NotesViewStatePorts,
  ViewStateSlot,
} from '@/lib/application/notes-view-state';
import type { HistoryAnchor } from '@/lib/application/history-window';
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
): NotesViewStatePorts {
  return {
    body: createCurrentCardSlot<CardScrollSnapshot>(currentCardId),
    history: createCurrentCardSlot<HistoryAnchor>(currentCardId),
    connections:
      createCurrentCardSlot<ConnectionsCameraSnapshot>(currentCardId),
  };
}
