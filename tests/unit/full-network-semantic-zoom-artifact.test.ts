import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeFullNetworkBenchmarkArtifactContract } from '@/tests/benchmarks/full-network-semantic-zoom-support';

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
});
