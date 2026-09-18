import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import {
  connectionsLayoutGraph,
  fullNetworkGraphShape,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';

function inputs(name: string) {
  const fixture = createFullNetworkBaselineFixture(name);
  const full = selectConnectionsViewModel(fixture.cards, fixture.currentCardId);
  return { fixture, full };
}

describe('full-network phase 0 fixtures', () => {
  it.each([
    ['boundary-64-connected', 64],
    ['boundary-65-connected', 65],
    ['boundary-256-connected', 256],
    ['boundary-257-connected', 257],
  ] as const)(
    'keeps complete membership at the layout boundary for %s',
    (name, fullNodes) => {
      const result = inputs(name);

      expect(result.full.nodes).toHaveLength(fullNodes);
      expect(new Set(result.full.nodes.map(({ cardId }) => cardId)).size).toBe(
        fullNodes,
      );
    },
  );

  it('retains every disconnected component and isolated node', () => {
    const first = inputs('boundary-257-mixed');
    const second = inputs('boundary-257-mixed');
    const shape = fullNetworkGraphShape(connectionsLayoutGraph(first.full));

    expect(second.full).toEqual(first.full);
    expect(shape).toMatchObject({
      nodes: 257,
      edges: 256,
      weaklyConnectedComponents: 35,
      isolatedNodes: 33,
      maximumComponentNodes: 160,
    });
    expect(first.full.nodes).toHaveLength(257);
  });

  it('provides fixed 1k/3k and product 10k graph inputs without a display cap', () => {
    const representative = inputs('representative-1000-e3000-mixed');
    const product = inputs('product-10000-existing');

    expect(representative.full).toMatchObject({
      nodes: { length: 1_000 },
      edges: { length: 3_000 },
    });
    expect(product.full.nodes).toHaveLength(10_000);
    expect(product.full.edges.length).toBeGreaterThan(10_000);
  });
});
