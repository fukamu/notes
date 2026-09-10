import { describe, expect, it } from 'vitest';
import { buildReachableGraph } from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';

function card(id: string, targets: string[]): CardRecord {
  return {
    id,
    displayId: { kind: 'official', value: id.charCodeAt(0) },
    title: id,
    body: targets.map((targetCardId) => ({ type: 'link', targetCardId })),
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
}

describe('reachable outgoing graph', () => {
  it('follows only explicit outgoing paths and terminates on cycles and self links', () => {
    const graph = buildReachableGraph(
      [card('A', ['B']), card('B', ['C', 'B']), card('C', ['A']), card('D', ['A'])],
      'A',
    );
    expect(graph.nodes.map((node) => node.card.id)).toEqual(['A', 'B', 'C']);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { sourceCardId: 'A', targetCardId: 'B' },
        { sourceCardId: 'B', targetCardId: 'C' },
        { sourceCardId: 'B', targetCardId: 'B' },
        { sourceCardId: 'C', targetCardId: 'A' },
      ]),
    );
  });
});
