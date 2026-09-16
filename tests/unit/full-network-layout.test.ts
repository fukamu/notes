import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkTopology,
  createFullNetworkTopologyFromNumeric,
  layoutFullNetworkTopology,
  sameFullNetworkTopology,
  validateFullNetworkLayout,
} from '@/lib/graph/full-network-layout';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId } from '@/tests/fixtures/ids';

const ids = Array.from({ length: 8 }, (_, index) =>
  fixtureCardId(`full-network-${index}`),
);

function id(index: number): CardId {
  const value = ids[index];
  if (value === undefined) throw new Error(`Missing fixture id ${index}`);
  return value;
}

function input(
  edges: readonly (readonly [number, number])[],
  nodeIds: readonly CardId[] = ids,
  currentCardId: CardId = id(0),
): ConnectionsInputModel {
  return {
    currentCardId,
    nodes: nodeIds.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Card ${index + 1}`,
      accessibleName: `Card ${index + 1}`,
      current: cardId === currentCardId,
    })),
    edges: edges.map(([source, target]) => ({
      sourceCardId: nodeIds[source] ?? id(source),
      targetCardId: nodeIds[target] ?? id(target),
      accessibleName: `${source} to ${target}`,
    })),
  };
}

describe('full-network deterministic layout core', () => {
  it('ignores current/title presentation changes in the exact structural identity', () => {
    const first = input([
      [0, 1],
      [1, 2],
    ]);
    const second: ConnectionsInputModel = {
      ...first,
      currentCardId: id(2),
      nodes: first.nodes.map((node) => ({
        ...node,
        title: `Renamed ${node.title}`,
        accessibleName: `Changed ${node.accessibleName}`,
        current: node.cardId === id(2),
      })),
    };
    const firstTopology = createFullNetworkTopology(first);
    const secondTopology = createFullNetworkTopology(second);
    expect(firstTopology.structuralKey).toBe(secondTopology.structuralKey);
    expect(sameFullNetworkTopology(firstTopology, secondTopology)).toBe(true);
  });

  it('places all disconnected, isolated, self, mutual, and cyclic identities once', () => {
    const topology = createFullNetworkTopology(
      input([
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 2],
        [2, 0],
        [3, 4],
      ]),
    );
    const beforeSources = [...topology.sources];
    const beforeTargets = [...topology.targets];
    const first = layoutFullNetworkTopology(topology);
    const second = layoutFullNetworkTopology(topology);

    expect(first.nodeCount).toBe(8);
    expect(first.edgeCount).toBe(6);
    expect(first.components).toHaveLength(5);
    expect([...second.x]).toEqual([...first.x]);
    expect([...second.y]).toEqual([...first.y]);
    expect(
      new Set([...first.x].map((x, node) => `${x}:${first.y[node]}`)),
    ).toHaveLength(8);
    expect([...topology.sources]).toEqual(beforeSources);
    expect([...topology.targets]).toEqual(beforeTargets);
  });

  it('reuses only component-local geometry whose exact topology survived', () => {
    const firstTopology = createFullNetworkTopology(
      input([
        [0, 1],
        [2, 3],
      ]),
    );
    const firstLayout = layoutFullNetworkTopology(firstTopology);
    const secondTopology = createFullNetworkTopology(input([[2, 3]]));
    const secondLayout = layoutFullNetworkTopology(secondTopology, undefined, {
      topology: firstTopology,
      layout: firstLayout,
    });

    expect(secondLayout.reusedComponentCount).toBe(5);
    const reused = secondLayout.components.filter(
      (component) => component.reused,
    );
    expect(
      reused.some(
        (component) =>
          JSON.stringify([...component.nodeIndexes]) === JSON.stringify([2, 3]),
      ),
    ).toBe(true);
    expect(
      reused
        .flatMap((component) => [...component.nodeIndexes])
        .sort((left, right) => left - right),
    ).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('reuses an unchanged component after unrelated node indexes shift', () => {
    const firstNodeIds = [id(0), id(1)];
    const firstTopology = createFullNetworkTopology(
      input([[0, 1]], firstNodeIds, id(0)),
    );
    const firstLayout = layoutFullNetworkTopology(firstTopology);
    const secondNodeIds = [id(7), id(0), id(1)];
    const secondTopology = createFullNetworkTopology(
      input([[1, 2]], secondNodeIds, id(0)),
    );
    const secondLayout = layoutFullNetworkTopology(secondTopology, undefined, {
      topology: firstTopology,
      layout: firstLayout,
    });

    expect(secondLayout.reusedComponentCount).toBe(1);
    expect(
      secondLayout.components.some(
        (component) =>
          component.reused &&
          JSON.stringify([...component.nodeIndexes]) === JSON.stringify([1, 2]),
      ),
    ).toBe(true);
  });

  it('keeps 10,000 isolated cards compact without overlap', () => {
    const nodeIds = Array.from({ length: 10_000 }, (_, index) =>
      fixtureCardId(`full-network-isolated-${index}`),
    );
    const current = nodeIds[0];
    if (!current) throw new Error('Isolated fixture omitted current node');
    const topology = createFullNetworkTopology(input([], nodeIds, current));
    const layout = layoutFullNetworkTopology(topology);
    expect(layout.nodeCount).toBe(10_000);
    expect(layout.components).toHaveLength(10_000);
    expect(layout.width * layout.height).toBeLessThan(4_000_000);
    expect(
      new Set([...layout.x].map((x, node) => `${x}:${layout.y[node]}`)),
    ).toHaveLength(10_000);
  });

  it('keeps the existing 10,000-card and 19,951-edge identity exact', () => {
    const cards = createClientPerformanceFixture();
    const current = cards[5_000];
    if (!current) throw new Error('10k fixture omitted current card');
    const model = selectConnectionsViewModel(cards, current.id);
    const topology = createFullNetworkTopology(model);
    const layout = layoutFullNetworkTopology(topology);
    expect(layout.nodeCount).toBe(10_000);
    expect(layout.edgeCount).toBe(19_951);
    expect(layout.x).toHaveLength(10_000);
    expect(layout.y).toHaveLength(10_000);
    expect(layout.components).toHaveLength(1);
  });

  it('fails closed for unordered, duplicate, out-of-range, and invalid geometry', () => {
    expect(() =>
      createFullNetworkTopologyFromNumeric(
        [id(0), id(1)],
        new Uint32Array([1, 0]),
        new Uint32Array([0, 1]),
      ),
    ).toThrow('canonically ordered');
    expect(() =>
      createFullNetworkTopologyFromNumeric(
        [id(0), id(1)],
        new Uint32Array([0, 0]),
        new Uint32Array([1, 1]),
      ),
    ).toThrow('duplicate');
    expect(() =>
      createFullNetworkTopologyFromNumeric(
        [id(0)],
        new Uint32Array([0]),
        new Uint32Array([1]),
      ),
    ).toThrow('unknown node');

    const topology = createFullNetworkTopology(input([[0, 1]]));
    const layout = layoutFullNetworkTopology(topology);
    layout.x[0] = Number.NaN;
    expect(() => validateFullNetworkLayout(topology, layout)).toThrow(
      'not finite',
    );
  });
});
