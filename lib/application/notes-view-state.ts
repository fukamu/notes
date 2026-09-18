import type { HistoryAnchor } from '@/lib/application/history-window';
import type { NotesCameraPosition } from '@/lib/application/navigation-camera-session';
import type { CardId } from '@/lib/domain/id';

export type CardScrollSnapshot = Readonly<{
  currentCardId: CardId;
  scrollY: number;
}>;

export type ViewStateSlot<T> = Readonly<{
  read: () => T | null;
  write: (snapshot: T) => void;
}>;

export type NotesViewStatePorts = Readonly<{
  body: ViewStateSlot<CardScrollSnapshot>;
  history: ViewStateSlot<HistoryAnchor>;
  connections: NotesCameraPosition;
}>;
