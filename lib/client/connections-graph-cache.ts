import {
  buildConnectionsGraph,
  type ConnectionsGraph,
} from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';
import type { NotesLocation } from '@/lib/application/navigation';

export type ConnectionsGraphBuilder = (cards: CardRecord[]) => ConnectionsGraph;

export type ConnectionsGraphCache = {
  select: (cards: CardRecord[]) => ConnectionsGraph;
  clear: () => void;
};

/** Keeps graph construction tied to one mounted Notes runtime. */
export function createConnectionsGraphCache(
  build: ConnectionsGraphBuilder = buildConnectionsGraph,
): ConnectionsGraphCache {
  let cachedCards: CardRecord[] | null = null;
  let cachedGraph: ConnectionsGraph | null = null;

  return {
    select: (cards) => {
      if (cachedCards !== cards || cachedGraph === null) {
        cachedCards = cards;
        cachedGraph = build(cards);
      }
      return cachedGraph;
    },
    clear: () => {
      cachedCards = null;
      cachedGraph = null;
    },
  };
}

export function selectConnectionsGraphForLocation(
  cache: ConnectionsGraphCache,
  cards: CardRecord[],
  location: NotesLocation,
): ConnectionsGraph | null {
  if (
    location.kind !== 'connections' ||
    !cards.some((card) => card.id === location.cardId)
  ) {
    return null;
  }
  return cache.select(cards);
}
