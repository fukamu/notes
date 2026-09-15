import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  defaultConnectionsStagingPolicy,
  nextConnectionsExpansionPage,
  selectConnectionsStage,
  type ConnectionsStagingPolicy,
} from '@/lib/graph/connections-staging';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId } from '@/tests/fixtures/ids';

const policy = {
  initialNodeLimit: 3,
  expansionPageSize: 2,
  maximumNodeLimit: 7,
} as const satisfies ConnectionsStagingPolicy;

function node(label: string, position: number) {
  const cardId = fixtureCardId(`staging-${label}`);
  return {
    cardId,
    displayLabel: `#${position + 1}`,
    title: `Card ${label}`,
    accessibleName: `#${position} Card ${label}`,
    current: label === 'A',
  };
}

function input(): ConnectionsInputModel {
  const nodes = 'ABCDEFGHIJ'.split('').map(node);
  const ids = new Map(nodes.map((item) => [item.title.slice(-1), item.cardId]));
  const id = (label: string): CardId => {
    const value = ids.get(label);
    if (!value) throw new Error(`Missing test card ${label}`);
    return value;
  };
  const pairs: readonly (readonly [string, string])[] = [
    ['A', 'B'],
    ['A', 'C'],
    ['A', 'D'],
    ['A', 'E'],
    ['A', 'F'],
    ['B', 'G'],
    ['G', 'H'],
    ['H', 'A'],
  ];
  const edges = pairs.map(([source, target]) => ({
    sourceCardId: id(source),
    targetCardId: id(target),
    accessibleName: `${source} to ${target}`,
  }));
  return { currentCardId: id('A'), nodes, edges };
}

describe('connections staged neighborhood selection', () => {
  it('preserves every component for a graph within the initial bound', () => {
    const source = input();
    const roomy = { ...policy, initialNodeLimit: 10, maximumNodeLimit: 10 };

    const selected = selectConnectionsStage(
      source,
      { expansionPage: 0 },
      roomy,
    );

    expect(selected.input).toEqual(source);
    expect(selected.visibleNodeCount).toBe(10);
    expect(selected.canExpand).toBe(false);
  });

  it('orders an undirected neighborhood deterministically across cycles and high degree', () => {
    const source = input();
    const first = selectConnectionsStage(source, { expansionPage: 0 }, policy);
    const repeated = selectConnectionsStage(
      source,
      { expansionPage: 0 },
      policy,
    );

    expect(first).toEqual(repeated);
    expect(first.input.nodes.map((item) => item.title)).toEqual([
      'Card A',
      'Card B',
      'Card C',
    ]);
    expect(first.input.edges.map((edge) => edge.accessibleName)).toEqual([
      'A to B',
      'A to C',
    ]);
    expect(first.nodeLimit).toBe(3);
    expect(first.canExpand).toBe(true);
  });

  it('expands by pages, stays idempotent at the maximum, and never adds disconnected nodes', () => {
    const source = input();
    const onePage = nextConnectionsExpansionPage(0, policy);
    const maximumPage = nextConnectionsExpansionPage(
      nextConnectionsExpansionPage(onePage, policy),
      policy,
    );
    const selected = selectConnectionsStage(
      source,
      { expansionPage: maximumPage },
      policy,
    );

    expect(onePage).toBe(1);
    expect(maximumPage).toBe(2);
    expect(nextConnectionsExpansionPage(maximumPage, policy)).toBe(2);
    expect(selected.visibleNodeCount).toBe(7);
    expect(selected.input.nodes.map((item) => item.title)).not.toContain(
      'Card I',
    );
    expect(selected.hiddenReachableNodeCount).toBe(1);
    expect(selected.canExpand).toBe(false);
    expect(selected.stoppedAtMaximum).toBe(true);
  });

  it('falls back safely when the current root is missing', () => {
    const source = input();
    const missing = fixtureCardId('missing-staging-root');
    const selected = selectConnectionsStage(
      { ...source, currentCardId: missing },
      { expansionPage: 0 },
      policy,
    );

    expect(selected.focusCardId).toBe(source.nodes[0]?.cardId);
    expect(selected.visibleNodeCount).toBeLessThanOrEqual(
      policy.initialNodeLimit,
    );
  });

  it('bounds a 10,000-card replica before it reaches the layout worker', () => {
    const cards = createClientPerformanceFixture();
    const current = cards[5_000];
    if (!current) throw new Error('10k fixture omitted its current card');
    const fullInput = selectConnectionsViewModel(cards, current.id);

    const selected = selectConnectionsStage(fullInput, { expansionPage: 0 });

    expect(selected.totalNodeCount).toBe(10_000);
    expect(selected.visibleNodeCount).toBe(
      defaultConnectionsStagingPolicy.initialNodeLimit,
    );
    expect(selected.input.nodes).toHaveLength(
      defaultConnectionsStagingPolicy.initialNodeLimit,
    );
    expect(
      selected.input.edges.every(
        (edge) =>
          selected.input.nodes.some(
            (item) => item.cardId === edge.sourceCardId,
          ) &&
          selected.input.nodes.some(
            (item) => item.cardId === edge.targetCardId,
          ),
      ),
    ).toBe(true);
  });
});
