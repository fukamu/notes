import { describe, expect, it } from 'vitest';
import { parseCardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  CONNECTIONS_SEMANTIC_PAGE_SIZE,
  prepareConnectionsSemanticIndex,
  resolveConnectionsDeletedCardFocusTarget,
  selectConnectionsSemanticPage,
} from '@/lib/graph/connections-semantic-list';

const cardId = (value: number) =>
  parseCardId(`00000000-0000-7000-8000-${value.toString().padStart(12, '0')}`);

function input(count: number): ConnectionsInputModel {
  const nodes = Array.from({ length: count }, (_, index) => ({
    cardId: cardId(index + 1),
    displayLabel: `#${index + 1}`,
    title: index === count - 1 ? '最終カード Alpha' : `カード ${index + 1}`,
    accessibleName: `#${index + 1} カード ${index + 1}`,
    current: index === 0,
  }));
  return {
    currentCardId: nodes[0]?.cardId ?? cardId(1),
    nodes,
    edges: nodes.flatMap((source, index) => {
      const target = nodes[index + 1];
      return target
        ? [
            {
              sourceCardId: source.cardId,
              targetCardId: target.cardId,
              accessibleName: `${source.title} から ${target.title} へのリンク`,
            },
          ]
        : [];
    }),
  };
}

describe('connections semantic list', () => {
  it('projects reusable card and directed-edge search records', () => {
    const prepared = prepareConnectionsSemanticIndex(input(3));
    expect(prepared.cards.map((record) => record.node.displayLabel)).toEqual([
      '#1',
      '#2',
      '#3',
    ]);
    expect(prepared.edges).toHaveLength(2);
    expect(prepared.edges[0]).toMatchObject({
      source: { displayLabel: '#1' },
      target: { displayLabel: '#2' },
    });
    expect(
      selectConnectionsSemanticPage(prepared.edges, '#1 カード 2', 1)
        .filteredCount,
    ).toBe(1);
  });

  it('covers every record exactly once across fixed-size pages', () => {
    const prepared = prepareConnectionsSemanticIndex(input(127));
    const seen = Array.from({ length: 3 }, (_, index) =>
      selectConnectionsSemanticPage(prepared.cards, '', index + 1),
    ).flatMap((page) => page.items.map((record) => record.node.cardId));
    expect(CONNECTIONS_SEMANTIC_PAGE_SIZE).toBe(50);
    expect(seen).toHaveLength(127);
    expect(new Set(seen).size).toBe(127);
    expect(seen).toEqual(prepared.cards.map((record) => record.node.cardId));
  });

  it('normalizes search and clamps invalid, empty and final pages', () => {
    const prepared = prepareConnectionsSemanticIndex(input(101));
    expect(
      selectConnectionsSemanticPage(prepared.cards, 'alpha', 1),
    ).toMatchObject({
      filteredCount: 1,
      page: 1,
      pageCount: 1,
      rangeStart: 1,
      rangeEnd: 1,
    });
    expect(
      selectConnectionsSemanticPage(prepared.cards, '', 999),
    ).toMatchObject({
      page: 3,
      pageCount: 3,
      rangeStart: 101,
      rangeEnd: 101,
    });
    expect(
      selectConnectionsSemanticPage(prepared.cards, 'missing', Number.NaN),
    ).toMatchObject({
      filteredCount: 0,
      page: 1,
      pageCount: 1,
      rangeStart: 0,
      rangeEnd: 0,
    });
  });

  it('moves focus predictably when a focused card is deleted', () => {
    const before = prepareConnectionsSemanticIndex(input(3));
    const after = prepareConnectionsSemanticIndex(input(2));
    const removed = before.cards[2];
    const retained = before.cards[1];
    if (!removed || !retained) throw new Error('Focus fixture is incomplete');
    expect(
      resolveConnectionsDeletedCardFocusTarget(
        removed.node.cardId,
        2,
        after.cards,
        after.cards,
      ),
    ).toEqual({ kind: 'item', pageIndex: 1 });
    expect(
      resolveConnectionsDeletedCardFocusTarget(removed.node.cardId, 0, [], []),
    ).toEqual({ kind: 'search' });
    expect(
      resolveConnectionsDeletedCardFocusTarget(
        retained.node.cardId,
        1,
        before.cards,
        before.cards,
      ),
    ).toEqual({ kind: 'unchanged' });
  });
});
