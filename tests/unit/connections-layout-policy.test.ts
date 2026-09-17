import { describe, expect, it } from 'vitest';
import {
  CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT,
  CONNECTIONS_ELK_MAXIMUM_NODE_COUNT,
  CONNECTIONS_LAYOUT_POLICY_REVISION,
  DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS,
  chooseConnectionsLayoutEngine,
} from '@/lib/graph/connections-layout-policy';

describe('connections layout policy', () => {
  it('keeps the full graph while selecting ELK only inside the provisional boundary', () => {
    expect(chooseConnectionsLayoutEngine(0, 0)).toBe('elk');
    expect(
      chooseConnectionsLayoutEngine(
        CONNECTIONS_ELK_MAXIMUM_NODE_COUNT,
        CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT,
      ),
    ).toBe('elk');
    expect(
      chooseConnectionsLayoutEngine(
        CONNECTIONS_ELK_MAXIMUM_NODE_COUNT + 1,
        CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT,
      ),
    ).toBe('corridor');
    expect(
      chooseConnectionsLayoutEngine(
        CONNECTIONS_ELK_MAXIMUM_NODE_COUNT,
        CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT + 1,
      ),
    ).toBe('corridor');
  });

  it('publishes geometry-affecting policy values for the shared cache key', () => {
    expect(DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS).toEqual({ laneSpacing: 8 });
    expect(CONNECTIONS_LAYOUT_POLICY_REVISION).toContain('n256-e1024');
    expect(CONNECTIONS_LAYOUT_POLICY_REVISION).toContain('lane8');
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid node count %s',
    (nodeCount) => {
      expect(() => chooseConnectionsLayoutEngine(nodeCount, 0)).toThrow(
        'node count must be a non-negative safe integer',
      );
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid edge count %s',
    (edgeCount) => {
      expect(() => chooseConnectionsLayoutEngine(0, edgeCount)).toThrow(
        'edge count must be a non-negative safe integer',
      );
    },
  );
});
