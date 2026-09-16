import { describe, expect, it } from 'vitest';
import { parseCardId } from '@/lib/domain/id';
import {
  createFullNetworkTopologyFromNumeric,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  decodeFullNetworkLayoutWorkerRequest,
  decodeFullNetworkLayoutWorkerResponse,
  type FullNetworkLayoutWorkerRequest,
} from '@/lib/graph/full-network-layout-protocol';

const nodeIds = [
  parseCardId('01991f20-61d2-7000-8000-000000000001'),
  parseCardId('01991f20-61d2-7000-8000-000000000002'),
];

function request(): FullNetworkLayoutWorkerRequest {
  return {
    kind: 'layout-full-network',
    requestId: 1,
    topology: createFullNetworkTopologyFromNumeric(
      nodeIds,
      new Uint32Array([0]),
      new Uint32Array([1]),
    ),
    configuration: defaultFullNetworkLayoutConfiguration,
  };
}

describe('full-network worker protocol boundary', () => {
  it('decodes typed requests and reconstructs their structural identity', () => {
    const candidate = request();
    const decoded = decodeFullNetworkLayoutWorkerRequest(candidate);
    expect(decoded.requestId).toBe(1);
    expect(decoded.topology.structuralKey).toBe(
      candidate.topology.structuralKey,
    );
    expect([...decoded.topology.sources]).toEqual([0]);
    expect(decoded.topology.sources).not.toBe(candidate.topology.sources);
  });

  it('decodes complete geometry only for the exact request', () => {
    const expected = request();
    const layout = layoutFullNetworkTopology(
      expected.topology,
      expected.configuration,
    );
    const response = decodeFullNetworkLayoutWorkerResponse(
      {
        kind: 'full-network-layout-completed',
        requestId: expected.requestId,
        topologyKey: expected.topology.structuralKey,
        layout,
      },
      expected,
    );
    expect(response.kind).toBe('full-network-layout-completed');
    expect(
      response.kind === 'full-network-layout-completed' && response.layout,
    ).toEqual(layout);
  });

  it('fails closed on plain arrays, forged keys, stale ids, and non-finite geometry', () => {
    const expected = request();
    expect(() =>
      decodeFullNetworkLayoutWorkerRequest({
        ...expected,
        topology: { ...expected.topology, sources: [0] },
      }),
    ).toThrow('Uint32Array');
    expect(() =>
      decodeFullNetworkLayoutWorkerRequest({
        ...expected,
        topology: { ...expected.topology, structuralKey: 'forged' },
      }),
    ).toThrow('does not match');

    const layout = layoutFullNetworkTopology(expected.topology);
    expect(() =>
      decodeFullNetworkLayoutWorkerResponse(
        {
          kind: 'full-network-layout-completed',
          requestId: 2,
          topologyKey: expected.topology.structuralKey,
          layout,
        },
        expected,
      ),
    ).toThrow('does not match');
    expect(() =>
      decodeFullNetworkLayoutWorkerResponse(
        {
          kind: 'full-network-layout-completed',
          requestId: 1,
          topologyKey: expected.topology.structuralKey,
          layout: {
            ...layout,
            x: new Float32Array([Number.NaN, 1]),
          },
        },
        expected,
      ),
    ).toThrow('not finite');
    const component = layout.components[0];
    if (!component) throw new Error('Fixture omitted its component');
    expect(() =>
      decodeFullNetworkLayoutWorkerResponse(
        {
          kind: 'full-network-layout-completed',
          requestId: 1,
          topologyKey: expected.topology.structuralKey,
          layout: {
            ...layout,
            components: [
              { ...component, nodeIndexes: new Uint32Array([0, 0]) },
            ],
          },
        },
        expected,
      ),
    ).toThrow('invalid node identity');
  });

  it('keeps worker failure reasons discriminated and request-bound', () => {
    const expected = request();
    expect(
      decodeFullNetworkLayoutWorkerResponse(
        {
          kind: 'full-network-layout-failed',
          requestId: 1,
          topologyKey: expected.topology.structuralKey,
          reason: 'layout-failed',
        },
        expected,
      ),
    ).toEqual({
      kind: 'full-network-layout-failed',
      requestId: 1,
      topologyKey: expected.topology.structuralKey,
      reason: 'layout-failed',
    });
  });
});
