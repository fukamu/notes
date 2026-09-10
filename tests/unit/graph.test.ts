import { describe, expect, it } from 'vitest';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardRecord, DisplayId } from '@/lib/domain/types';

function card(
  id: string,
  targets: string[],
  displayId: DisplayId = { kind: 'official', value: id.charCodeAt(0) },
): CardRecord {
  return {
    id,
    displayId,
    title: id,
    body: targets.map((targetCardId) => ({ type: 'link', targetCardId })),
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
}

describe('all-card outgoing graph', () => {
  it('includes isolated cards and components unreachable from the current card', () => {
    const graph = buildConnectionsGraph([
      card('A', ['B']),
      card('B', []),
      card('C', []),
      card('D', ['E']),
      card('E', []),
    ]);

    expect(graph.nodes.map((node) => node.card.id)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(graph.edges).toEqual([
      { sourceCardId: 'A', targetCardId: 'B' },
      { sourceCardId: 'D', targetCardId: 'E' },
    ]);
  });

  it('collects every explicit direction, deduplicates pairs, and ignores missing targets', () => {
    const graph = buildConnectionsGraph([
      card('A', ['B', 'B', 'missing', 'C']),
      card('B', ['A']),
      card('C', []),
    ]);

    expect(graph.edges).toEqual([
      { sourceCardId: 'A', targetCardId: 'B' },
      { sourceCardId: 'A', targetCardId: 'C' },
      { sourceCardId: 'B', targetCardId: 'A' },
    ]);
  });

  it('keeps cycles and self links without synthesizing reverse links', () => {
    const graph = buildConnectionsGraph([
      card('A', ['A', 'B']),
      card('B', ['C']),
      card('C', ['A']),
      card('D', []),
    ]);

    expect(graph.edges).toEqual([
      { sourceCardId: 'A', targetCardId: 'A' },
      { sourceCardId: 'A', targetCardId: 'B' },
      { sourceCardId: 'B', targetCardId: 'C' },
      { sourceCardId: 'C', targetCardId: 'A' },
    ]);
  });

  it('orders nodes and edges deterministically by displayId number then UUID', () => {
    const cards = [
      card('uuid-z', [], { kind: 'official', value: 4 }),
      card('uuid-c', ['uuid-z'], { kind: 'provisional', value: 2 }),
      card('uuid-a', ['uuid-z', 'uuid-c'], { kind: 'official', value: 2 }),
      card('uuid-b', [], { kind: 'official', value: 1 }),
    ];

    const first = buildConnectionsGraph(cards);
    const second = buildConnectionsGraph([...cards].reverse());

    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.card.id)).toEqual([
      'uuid-b',
      'uuid-a',
      'uuid-c',
      'uuid-z',
    ]);
    expect(first.edges).toEqual([
      { sourceCardId: 'uuid-a', targetCardId: 'uuid-c' },
      { sourceCardId: 'uuid-a', targetCardId: 'uuid-z' },
      { sourceCardId: 'uuid-c', targetCardId: 'uuid-z' },
    ]);
  });
});
