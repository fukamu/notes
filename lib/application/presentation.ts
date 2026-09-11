import type { CardId, ConflictId } from '@/lib/domain/id';
import type { BodySegment, CardRecord } from '@/lib/domain/types';
import type { NotesLocation } from '@/lib/application/navigation';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';

export type NotesViewName = 'card' | 'history' | 'connections';

export type NotesStatusKind =
  | 'saved'
  | 'saving'
  | 'save-failed'
  | 'syncing'
  | 'offline'
  | 'sync-failed';

export type NotesStatusViewModel = {
  kind: NotesStatusKind;
  label: string;
  retryable: boolean;
};

export type HistoryItemViewModel = {
  cardId: CardId;
  displayLabel: string;
  displayValue: number;
  title: string;
  preview: string;
  current: boolean;
};

export type HistoryViewModel = {
  currentCardId: CardId | null;
  items: HistoryItemViewModel[];
};

export type ConflictChoice = 'local' | 'server';

export type ConflictOptionViewModel = {
  choice: ConflictChoice;
  heading: string;
  title: string;
  preview: string;
  accessibleName: string;
};

export type ConflictViewModel = {
  conflictId: ConflictId;
  cardId: CardId;
  options: [ConflictOptionViewModel, ConflictOptionViewModel];
};

export type CardEditorLabelModel = {
  cardId: CardId;
  label: string;
};

export type CardEditorCandidateModel = {
  cardId: CardId;
  displayLabel: string;
  title: string;
};

export type CardEditorInputModel = {
  cardId: CardId;
  body: BodySegment[];
  labels: CardEditorLabelModel[];
  candidates: CardEditorCandidateModel[];
};

export type ConnectionsViewModel = ConnectionsInputModel;

export type NotesPresentationModel = {
  initialized: boolean;
  location: NotesLocation;
  activeView: NotesViewName;
  availableViews: Record<NotesViewName, boolean>;
  currentCard: CardRecord | null;
  currentCardDisplayLabel: string | null;
  cardEditor: CardEditorInputModel | null;
  history: HistoryViewModel;
  conflicts: ConflictViewModel[];
  connections: ConnectionsViewModel | null;
  status: NotesStatusViewModel;
};

export type NotesPresentationActions = {
  createCard: () => Promise<void>;
  openCard: (cardId: CardId) => void;
  showCurrentCard: () => void;
  showHistory: () => void;
  showConnections: () => void;
  updateTitle: (title: string) => void;
  updateBody: (body: BodySegment[]) => void;
  retrySync: () => Promise<void>;
  resolveConflict: (conflictId: ConflictId, choice: ConflictChoice) => void;
};
