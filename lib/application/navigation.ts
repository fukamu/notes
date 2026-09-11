import type { CardId } from '@/lib/domain/id';

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

export type NotesNavigator = {
  getLocation: () => NotesLocation;
  navigate: (intent: NotesNavigationIntent) => NotesLocation;
  subscribe: (listener: () => void) => () => void;
};

export const EMPTY_NOTES_LOCATION: NotesLocation = { kind: 'empty' };

export function notesLocationCardId(location: NotesLocation): CardId | null {
  return location.kind === 'empty' ? null : location.cardId;
}

function sameLocation(left: NotesLocation, right: NotesLocation): boolean {
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

  return sameLocation(current, next) ? current : next;
}

export function createInMemoryNotesNavigator(
  initialLocation: NotesLocation = EMPTY_NOTES_LOCATION,
): NotesNavigator {
  let location = initialLocation;
  const listeners = new Set<() => void>();

  return {
    getLocation: () => location,
    navigate: (intent) => {
      const next = reduceNotesLocation(location, intent);
      if (next !== location) {
        location = next;
        for (const listener of listeners) listener();
      }
      return location;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
