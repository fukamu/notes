import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeFullNetworkBenchmarkArtifactContract } from '@/tests/benchmarks/full-network-semantic-zoom-support';

function finiteNumber(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new TypeError(`${label} must be finite`);
  }
  return input;
}

describe('checked-in full-network semantic zoom artifact', () => {
  it('retains the complete representative and quota-derived graph contracts', async () => {
    const serialized = await readFile(
      'docs/benchmarks/full-network-semantic-zoom.json',
      'utf8',
    );
    const artifact = decodeFullNetworkBenchmarkArtifactContract(
      JSON.parse(serialized),
    );
    expect(artifact).toEqual({
      issue: 285,
      branchPoint: '4341bed780b0fd2d797f5bef3505fd64c3670495',
      displaySampling: false,
      selectedCandidate: 'component-bfs-serpentine',
      representative: { nodes: 10_000, directedEdges: 19_951 },
      dense: { nodes: 10_000, directedEdges: 1_160_000 },
      renderers: [
        {
          graph: 'representative-10k',
          nodeCount: 10_000,
          edgeCount: 19_951,
          offscreenCanvas: true,
          workerWebgl2: true,
          webgl2: true,
          retainedGeometryBytes: 399_216,
        },
        {
          graph: 'dense-10000-116',
          nodeCount: 10_000,
          edgeCount: 1_160_000,
          offscreenCanvas: true,
          workerWebgl2: true,
          webgl2: true,
          retainedGeometryBytes: 18_640_000,
        },
      ],
    });
  });

  it('records exact v1/v2 organic-wiring evidence without display sampling', async () => {
    const serialized = await readFile(
      'docs/benchmarks/full-network-organic-wiring.json',
      'utf8',
    );
    const artifact: unknown = JSON.parse(serialized);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      issue: 301,
      branchPoint: 'd4a915ed1f5fad86d4f0c6f0caf6bbdbc029bb4e',
      policy: { displaySampling: false },
      retainedGeometryBytes: {
        representative: 399_216,
        dense: 18_640_000,
        changedFromBaseline: false,
      },
      graphs: [
        {
          name: 'representative-10k',
          nodeCount: 10_000,
          edgeCount: 19_951,
          baseline: { algorithm: 'component-bfs-serpentine-v1' },
          production: { algorithm: 'component-bfs-warped-v2' },
        },
        {
          name: 'dense-10000-116',
          nodeCount: 10_000,
          edgeCount: 1_160_000,
          baseline: { algorithm: 'component-bfs-serpentine-v1' },
          production: { algorithm: 'component-bfs-warped-v2' },
        },
      ],
    });
    if (typeof artifact !== 'object' || artifact === null) {
      throw new TypeError('Organic wiring artifact must be an object');
    }
    const graphs: unknown = Reflect.get(artifact, 'graphs');
    if (!Array.isArray(graphs)) {
      throw new TypeError('Organic wiring artifact graphs must be an array');
    }
    for (const graph of graphs) {
      if (typeof graph !== 'object' || graph === null) {
        throw new TypeError('Organic wiring graph evidence must be an object');
      }
      const baseline: unknown = Reflect.get(graph, 'baseline');
      const production: unknown = Reflect.get(graph, 'production');
      if (
        typeof baseline !== 'object' ||
        baseline === null ||
        typeof production !== 'object' ||
        production === null
      ) {
        throw new TypeError('Organic wiring comparison is incomplete');
      }
      const baselineGeometry: unknown = Reflect.get(baseline, 'geometry');
      const productionGeometry: unknown = Reflect.get(production, 'geometry');
      if (
        typeof baselineGeometry !== 'object' ||
        baselineGeometry === null ||
        typeof productionGeometry !== 'object' ||
        productionGeometry === null
      ) {
        throw new TypeError('Organic wiring geometry evidence is incomplete');
      }
      const baselineCoordinates: unknown = Reflect.get(
        baselineGeometry,
        'coordinateConcentration',
      );
      const productionCoordinates: unknown = Reflect.get(
        productionGeometry,
        'coordinateConcentration',
      );
      if (
        typeof baselineCoordinates !== 'object' ||
        baselineCoordinates === null ||
        typeof productionCoordinates !== 'object' ||
        productionCoordinates === null
      ) {
        throw new TypeError('Organic wiring coordinate evidence is incomplete');
      }
      expect(
        finiteNumber(
          Reflect.get(productionCoordinates, 'uniqueX'),
          'production.uniqueX',
        ),
      ).toBeGreaterThan(
        finiteNumber(
          Reflect.get(baselineCoordinates, 'uniqueX'),
          'baseline.uniqueX',
        ),
      );
      expect(
        finiteNumber(
          Reflect.get(productionCoordinates, 'uniqueY'),
          'production.uniqueY',
        ),
      ).toBeGreaterThan(
        finiteNumber(
          Reflect.get(baselineCoordinates, 'uniqueY'),
          'baseline.uniqueY',
        ),
      );
    }
  });
});
