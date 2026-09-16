import { describe, expect, it } from 'vitest';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkAccessibilityIndex,
  createFullNetworkAccessibilityOverlay,
  deriveFullNetworkAvailability,
  describeFullNetworkAccessibility,
  fullNetworkAccessibilityOverlayLimit,
  initialFullNetworkAccessibilityCursor,
  transitionFullNetworkAccessibilityCursor,
} from '@/lib/graph/full-network-accessibility';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  createFullNetworkRenderDataset,
  createFullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { fixtureCardId } from '@/tests/fixtures/ids';

function fixture(
  nodeCount: number,
  pairs: readonly (readonly [number, number])[],
) {
  const ids = Array.from({ length: nodeCount }, (_, index) =>
    fixtureCardId(`full-network-accessibility-${nodeCount}-${index}`),
  );
  const id = (index: number): CardId => {
    const value = ids[index];
    if (!value) throw new Error(`Missing accessibility fixture ${index}`);
    return value;
  };
  const input: ConnectionsInputModel = {
    currentCardId: id(0),
    nodes: ids.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Accessible card ${index + 1}`,
      accessibleName: `Card ${index + 1}, Accessible card ${index + 1}`,
      current: index === 0,
    })),
    edges: pairs.map(([source, target], index) => ({
      sourceCardId: id(source),
      targetCardId: id(target),
      accessibleName: `Link ${index + 1}, ${source + 1} to ${target + 1}`,
    })),
  };
  const node = (index: number) => {
    const value = input.nodes[index];
    if (!value) throw new Error(`Missing semantic node ${index}`);
    return value;
  };
  const edge = (index: number) => {
    const value = input.edges[index];
    if (!value) throw new Error(`Missing semantic edge ${index}`);
    return value;
  };
  const topology = createFullNetworkTopology(input);
  const layout = layoutFullNetworkTopology(topology);
  const dataset = createFullNetworkRenderDataset(
    createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    ),
  );
  return {
    ids,
    input,
    dataset,
    index: createFullNetworkAccessibilityIndex(input, dataset),
    node,
    edge,
  };
}

describe('full-network bounded accessibility core', () => {
  it('rejects semantic node or edge order that differs from rendered data', () => {
    const value = fixture(3, [
      [0, 1],
      [1, 2],
    ]);
    expect(() =>
      createFullNetworkAccessibilityIndex(
        {
          ...value.input,
          nodes: [value.node(1), value.node(0), value.node(2)],
        },
        value.dataset,
      ),
    ).toThrow('Accessible node order differs');
    expect(() =>
      createFullNetworkAccessibilityIndex(
        {
          ...value.input,
          edges: [value.edge(1), value.edge(0)],
        },
        value.dataset,
      ),
    ).toThrow('Accessible edge order differs');
  });

  it('reaches every node and every directed edge with finite keyboard traversal', () => {
    const pairs = Array.from({ length: 1_000 }, (_, source) =>
      [
        [source, (source + 1) % 1_000] as const,
        [source, (source + 17) % 1_000] as const,
      ].sort((left, right) => left[1] - right[1]),
    ).flat();
    const value = fixture(1_000, pairs);
    let cursor = initialFullNetworkAccessibilityCursor(value.index);
    const nodes = new Set<number>();
    for (let step = 0; step < value.index.nodes.length; step += 1) {
      cursor = transitionFullNetworkAccessibilityCursor(
        value.index,
        value.dataset,
        cursor,
        { type: 'next-node', direction: 1 },
      );
      if (cursor.nodeIndex !== null) nodes.add(cursor.nodeIndex);
    }
    expect(nodes.size).toBe(value.index.nodes.length);

    const edges = new Set<number>();
    for (let step = 0; step < value.index.edges.length; step += 1) {
      cursor = transitionFullNetworkAccessibilityCursor(
        value.index,
        value.dataset,
        cursor,
        { type: 'next-edge', direction: 1 },
      );
      if (cursor.edgeIndex !== null) edges.add(cursor.edgeIndex);
    }
    expect(edges.size).toBe(value.index.edges.length);
  });

  it('supports spatial, adjacent, component, current and direct-card navigation', () => {
    const value = fixture(7, [
      [0, 1],
      [1, 2],
      [3, 4],
      [4, 3],
      [5, 5],
    ]);
    const initial = initialFullNetworkAccessibilityCursor(value.index);
    const spatial = transitionFullNetworkAccessibilityCursor(
      value.index,
      value.dataset,
      initial,
      { type: 'move', direction: 'right' },
    );
    expect(spatial.nodeIndex).not.toBeNull();
    const neighbor = transitionFullNetworkAccessibilityCursor(
      value.index,
      value.dataset,
      initial,
      { type: 'next-neighbor', direction: 1 },
    );
    expect(neighbor.edgeIndex).toBe(0);
    expect(neighbor.nodeIndex).toBe(1);
    const component = transitionFullNetworkAccessibilityCursor(
      value.index,
      value.dataset,
      initial,
      { type: 'next-component', direction: 1 },
    );
    expect(component.nodeIndex).not.toBe(initial.nodeIndex);
    const direct = transitionFullNetworkAccessibilityCursor(
      value.index,
      value.dataset,
      component,
      { type: 'select-card', cardId: idAt(value.ids, 6) },
    );
    expect(direct.nodeIndex).toBe(6);
    expect(
      transitionFullNetworkAccessibilityCursor(
        value.index,
        value.dataset,
        direct,
        { type: 'select-current' },
      ).nodeIndex,
    ).toBe(0);
  });

  it('announces totals, LOD, current card, selected card and directed edge', () => {
    const value = fixture(3, [
      [0, 1],
      [1, 0],
    ]);
    const cursor = initialFullNetworkAccessibilityCursor(
      value.index,
      value.ids[2],
    );
    expect(
      describeFullNetworkAccessibility(value.index, cursor, 'network'),
    ).toEqual({
      summary:
        'つながりマップ。全3枚、全2本。表示段階はネットワーク。現在のカードはCard 1, Accessible card 1。',
      selection: 'カード 3/3、Card 3, Accessible card 3',
    });
    const edge = transitionFullNetworkAccessibilityCursor(
      value.index,
      value.dataset,
      cursor,
      { type: 'next-edge', direction: 1 },
    );
    expect(
      describeFullNetworkAccessibility(value.index, edge, 'overview').selection,
    ).toBe('リンク 1/2、Link 1, 1 to 2');
  });

  it('keeps the detail DOM overlay viewport-bounded for a 10k graph', () => {
    const pairs = Array.from(
      { length: 9_999 },
      (_, index) => [index, index + 1] as const,
    );
    const value = fixture(10_000, pairs);
    const plan = createFullNetworkRenderPlan({
      dataset: value.dataset,
      camera: {
        offsetX: 320,
        offsetY: 210,
        scale: 6,
        viewportWidth: 640,
        viewportHeight: 420,
      },
      currentCardId: idAt(value.ids, 0),
      selectedCardId: idAt(value.ids, 1),
      reducedMotion: true,
    });
    expect(plan.level).toBe('detail');
    const overlay = createFullNetworkAccessibilityOverlay(
      value.index,
      value.dataset,
      plan,
    );
    expect(overlay.length).toBeLessThanOrEqual(
      fullNetworkAccessibilityOverlayLimit(640, 420),
    );
    expect(overlay.length).toBeLessThan(value.index.nodes.length);
    expect(new Set(overlay.map((item) => item.nodeIndex)).size).toBe(
      overlay.length,
    );
  });

  it('distinguishes complete, stale, retryable, loading and destroyed states', () => {
    expect(
      deriveFullNetworkAvailability({
        layout: { status: 'ready', hasCompleteLayout: true },
        renderer: { status: 'ready' },
      }),
    ).toEqual({ kind: 'ready' });
    expect(
      deriveFullNetworkAvailability({
        layout: { status: 'refreshing', hasCompleteLayout: true },
        renderer: { status: 'ready' },
      }),
    ).toMatchObject({ kind: 'stale', retryable: false });
    expect(
      deriveFullNetworkAvailability({
        layout: {
          status: 'error',
          hasCompleteLayout: true,
          reason: 'invalid-response',
        },
        renderer: { status: 'ready' },
      }),
    ).toMatchObject({ kind: 'stale', retryable: true });
    expect(
      deriveFullNetworkAvailability({
        layout: {
          status: 'error',
          hasCompleteLayout: false,
          reason: 'worker-failure',
        },
        renderer: { status: 'idle' },
      }),
    ).toMatchObject({ kind: 'error', retryable: true });
    expect(
      deriveFullNetworkAvailability({
        layout: { status: 'ready', hasCompleteLayout: true },
        renderer: { status: 'context-lost' },
      }),
    ).toMatchObject({ kind: 'error', retryable: true });
    expect(
      deriveFullNetworkAvailability({
        layout: { status: 'loading', hasCompleteLayout: false },
        renderer: { status: 'building' },
      }),
    ).toMatchObject({ kind: 'loading' });
    expect(
      deriveFullNetworkAvailability({
        layout: { status: 'destroyed', hasCompleteLayout: false },
        renderer: { status: 'disposed' },
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });
});

function idAt(ids: readonly CardId[], index: number): CardId {
  const value = ids[index];
  if (!value) throw new Error(`Missing fixture id ${index}`);
  return value;
}
