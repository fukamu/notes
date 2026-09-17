import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import { selectConnectionsStage } from '@/lib/graph/connections-staging';
import {
  connectionsLayoutGraph,
  fullNetworkGraphShape,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';

function inputs(name: string) {
  const fixture = createFullNetworkBaselineFixture(name);
  const full = selectConnectionsViewModel(fixture.cards, fixture.currentCardId);
  const staged = selectConnectionsStage(full, { expansionPage: 0 });
  return { fixture, full, staged };
}

describe('full-network phase 0 fixtures', () => {
  it.each([
    ['boundary-64-connected', 64, 64],
    ['boundary-65-connected', 65, 64],
    ['boundary-256-connected', 256, 64],
    ['boundary-257-connected', 257, 64],
  ] as const)(
    'separates complete membership from current staging for %s',
    (name, fullNodes, stagedNodes) => {
      const result = inputs(name);

      expect(result.full.nodes).toHaveLength(fullNodes);
      expect(result.staged.input.nodes).toHaveLength(stagedNodes);
      expect(new Set(result.full.nodes.map(({ cardId }) => cardId)).size).toBe(
        fullNodes,
      );
    },
  );

  it('retains every disconnected component and isolated node before staging', () => {
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
    expect(first.staged.input.nodes).toHaveLength(64);
    expect(first.staged.input.nodes).not.toEqual(first.full.nodes);
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
    expect(product.staged.input.nodes).toHaveLength(64);
  });
});
