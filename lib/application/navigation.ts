import type { CardId } from '@/lib/domain/id';
import {
  createNotesCameraSession,
  type NotesCameraSession,
} from '@/lib/application/navigation-camera-session';

export type NotesLocation =
  | { kind: 'empty' }
  | { kind: 'card'; cardId: CardId }
  | { kind: 'history'; cardId: CardId | null }
  | { kind: 'connections'; cardId: CardId };

export type NotesNavigationIntent =
  | { type: 'initialize'; cardIds: CardId[] }
  | { type: 'reconcile-cards'; cardIds: CardId[] }
  | { type: 'open-card'; cardId: CardId }
  | { type: 'show-current-card' }
  | { type: 'show-history' }
  | { type: 'show-connections' };

export type NotesHistoryEffect =
  | { type: 'noop' }
  | { type: 'push' }
  | { type: 'replace' }
  | { type: 'return-to-previous' };

export type NotesNavigationCause =
  | 'initial'
  | 'initialize'
  | 'open-card'
  | 'tab'
  | 'traverse'
  | 'reconcile';

export type NotesNavigationSnapshot = Readonly<{
  location: NotesLocation;
  entryId: number;
  activationId: number;
  cause: NotesNavigationCause;
  pending: boolean;
}>;

export type NotesNavigator = {
  getLocation: () => NotesLocation;
  getSnapshot: () => NotesNavigationSnapshot;
  navigate: (intent: NotesNavigationIntent) => NotesLocation;
  subscribe: (listener: () => void) => () => void;
  cameraSession: NotesCameraSession;
};

export const EMPTY_NOTES_LOCATION: NotesLocation = { kind: 'empty' };
export const SERVER_NOTES_NAVIGATION_SNAPSHOT: NotesNavigationSnapshot = {
  location: EMPTY_NOTES_LOCATION,
  entryId: 0,
  activationId: 0,
  cause: 'initial',
  pending: false,
};

export function notesLocationCardId(location: NotesLocation): CardId | null {
  return location.kind === 'empty' ? null : location.cardId;
}

export function areNotesLocationsEqual(
  left: NotesLocation,
  right: NotesLocation,
): boolean {
  return (
    left.kind === right.kind &&
    notesLocationCardId(left) === notesLocationCardId(right)
  );
}

function cardExists(
  cardIds: CardId[],
  cardId: CardId | null,
): cardId is CardId {
  return cardId !== null && cardIds.includes(cardId);
}

function lastCardId(cardIds: CardId[]): CardId | null {
  return cardIds.at(-1) ?? null;
}

export function reduceNotesLocation(
  current: NotesLocation,
  intent: NotesNavigationIntent,
): NotesLocation {
  let next: NotesLocation;

  switch (intent.type) {
    case 'initialize': {
      if (current.kind !== 'empty') {
        return reduceNotesLocation(current, {
          type: 'reconcile-cards',
          cardIds: intent.cardIds,
        });
      }
      const cardId = lastCardId(intent.cardIds);
      next = cardId ? { kind: 'card', cardId } : EMPTY_NOTES_LOCATION;
      break;
    }
    case 'reconcile-cards': {
      const currentCardId = notesLocationCardId(current);
      if (cardExists(intent.cardIds, currentCardId)) return current;
      if (current.kind === 'history') {
        next = { kind: 'history', cardId: null };
        break;
      }
      const fallbackCardId = lastCardId(intent.cardIds);
      next = fallbackCardId
        ? { kind: 'card', cardId: fallbackCardId }
        : EMPTY_NOTES_LOCATION;
      break;
    }
    case 'open-card':
      next = { kind: 'card', cardId: intent.cardId };
      break;
    case 'show-current-card': {
      const cardId = notesLocationCardId(current);
      next = cardId ? { kind: 'card', cardId } : current;
      break;
    }
    case 'show-history':
      next = { kind: 'history', cardId: notesLocationCardId(current) };
      break;
    case 'show-connections': {
      const cardId = notesLocationCardId(current);
      next = cardId ? { kind: 'connections', cardId } : current;
      break;
    }
  }

  return areNotesLocationsEqual(current, next) ? current : next;
}

export function decideNotesHistoryEffect(input: {
  current: NotesLocation;
  next: NotesLocation;
  intent: NotesNavigationIntent;
  previousManagedLocation: NotesLocation | null;
}): NotesHistoryEffect {
  if (areNotesLocationsEqual(input.current, input.next)) {
    return { type: 'noop' };
  }

  switch (input.intent.type) {
    case 'initialize':
    case 'reconcile-cards':
      return { type: 'replace' };
    case 'open-card':
      return input.current.kind === 'empty'
        ? { type: 'replace' }
        : { type: 'push' };
    case 'show-current-card':
      return { type: 'replace' };
    case 'show-history':
    case 'show-connections':
      return input.previousManagedLocation?.kind === input.next.kind
        ? { type: 'return-to-previous' }
        : { type: 'replace' };
  }
}

export function notesNavigationCause(
  intent: NotesNavigationIntent,
): Exclude<NotesNavigationCause, 'initial' | 'traverse'> {
  switch (intent.type) {
    case 'initialize':
      return 'initialize';
    case 'reconcile-cards':
      return 'reconcile';
    case 'open-card':
      return 'open-card';
    case 'show-current-card':
    case 'show-history':
    case 'show-connections':
      return 'tab';
  }
}

export function createInMemoryNotesNavigator(
  initialLocation: NotesLocation = EMPTY_NOTES_LOCATION,
): NotesNavigator {
  let location = initialLocation;
  let snapshot: NotesNavigationSnapshot = {
    location,
    entryId: 1,
    activationId: 1,
    cause: 'initial',
    pending: false,
  };
  const listeners = new Set<() => void>();
  const cameraSession = createNotesCameraSession(() => snapshot);

  return {
    getLocation: () => location,
    getSnapshot: () => snapshot,
    navigate: (intent) => {
      const next = reduceNotesLocation(location, intent);
      if (next !== location) {
        const previous = location;
        const effect = decideNotesHistoryEffect({
          current: previous,
          next,
          intent,
          previousManagedLocation: null,
        });
        location = next;
        const entryId =
          effect.type === 'push' ? snapshot.entryId + 1 : snapshot.entryId;
        cameraSession.replaceEntry(entryId, previous, next);
        snapshot = {
          location,
          entryId,
          activationId: snapshot.activationId + 1,
          cause: notesNavigationCause(intent),
          pending: false,
        };
        for (const listener of listeners) listener();
      }
      return location;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cameraSession,
  };
}
