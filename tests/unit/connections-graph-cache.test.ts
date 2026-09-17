import { describe, expect, it, vi } from 'vitest';
import {
  createConnectionsGraphCache,
  selectConnectionsGraphForLocation,
} from '@/lib/client/connections-graph-cache';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

function card(label: string): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: 1 },
    title: label,
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
}

describe('connections graph cache', () => {
  it('builds lazily and reuses one graph for the same cards identity', () => {
    const build = vi.fn(buildConnectionsGraph);
    const cache = createConnectionsGraphCache(build);
    const cards = [card('connections-cache-first')];

    expect(build).not.toHaveBeenCalled();
    const first = cache.select(cards);
    expect(cache.select(cards)).toBe(first);
    expect(build).toHaveBeenCalledOnce();
  });

  it('rebuilds for a changed cards identity and after the runtime is cleared', () => {
    const build = vi.fn(buildConnectionsGraph);
    const cache = createConnectionsGraphCache(build);
    const firstCards = [card('connections-cache-first-cards')];
    const secondCards = [...firstCards];

    const first = cache.select(firstCards);
    const second = cache.select(secondCards);
    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);

    cache.clear();
    expect(cache.select(secondCards)).not.toBe(second);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('stays demand-driven and reuses the graph across status and selection changes', () => {
    const build = vi.fn(buildConnectionsGraph);
    const cache = createConnectionsGraphCache(build);
    const cards: CardRecord[] = [
      card('connections-demand-first'),
      {
        ...card('connections-demand-second'),
        displayId: { kind: 'official', value: 2 },
      },
    ];

    expect(
      selectConnectionsGraphForLocation(cache, cards, {
        kind: 'card',
        cardId: cards[0]?.id ?? fixtureCardId('missing-first'),
      }),
    ).toBeNull();
    expect(
      selectConnectionsGraphForLocation(cache, cards, {
        kind: 'history',
        cardId: cards[0]?.id ?? fixtureCardId('missing-history'),
      }),
    ).toBeNull();
    expect(build).not.toHaveBeenCalled();

    const first = selectConnectionsGraphForLocation(cache, cards, {
      kind: 'connections',
      cardId: cards[0]?.id ?? fixtureCardId('missing-connections-first'),
    });
    const statusOnly = selectConnectionsGraphForLocation(cache, cards, {
      kind: 'connections',
      cardId: cards[0]?.id ?? fixtureCardId('missing-status'),
    });
    const selectionOnly = selectConnectionsGraphForLocation(cache, cards, {
      kind: 'connections',
      cardId: cards[1]?.id ?? fixtureCardId('missing-connections-second'),
    });

    expect(statusOnly).toBe(first);
    expect(selectionOnly).toBe(first);
    expect(build).toHaveBeenCalledOnce();
  });
});
