import type { CardId, ConflictId } from '@/lib/domain/id';
import type { ConflictResolutionChoice } from '@/lib/domain/card-transitions';
import type { BodySegment, CardRecord } from '@/lib/domain/types';
import type { NotesLocation } from '@/lib/application/navigation';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';

export type NotesViewName = 'card' | 'history' | 'connections';

export type NotesStatusViewModel =
  | { kind: 'saved'; label: string; retryable: false }
  | { kind: 'saving'; label: string; retryable: false }
  | { kind: 'save-failed'; label: string; retryable: false }
  | { kind: 'syncing'; label: string; retryable: false }
  | { kind: 'offline'; label: string; retryable: false }
  | { kind: 'sync-failed'; label: string; retryable: true };

export type NotesStatusKind = NotesStatusViewModel['kind'];

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

export type ConflictChoice = ConflictResolutionChoice;

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
  displayValue: number;
  title: string;
};

export type CardEditorInputModel = {
  cardId: CardId;
  body: BodySegment[];
  labels: CardEditorLabelModel[];
  candidates: CardEditorCandidateModel[];
};

export type ConnectionsViewModel = ConnectionsInputModel;

type NotesPresentationModelBase = {
  initialized: boolean;
  location: NotesLocation;
  availableViews: Record<NotesViewName, boolean>;
  currentCard: CardRecord | null;
  currentCardDisplayLabel: string | null;
  conflicts: ConflictViewModel[];
  status: NotesStatusViewModel;
};

export type NotesPresentationModel = NotesPresentationModelBase &
  (
    | {
        activeView: 'card';
        cardEditor: CardEditorInputModel | null;
        history: null;
        connections: null;
      }
    | {
        activeView: 'history';
        cardEditor: null;
        history: HistoryViewModel;
        connections: null;
      }
    | {
        activeView: 'connections';
        cardEditor: null;
        history: null;
        connections: ConnectionsViewModel | null;
      }
  );

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
