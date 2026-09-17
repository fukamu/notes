import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeBrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';

function validResult(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    fixture: 'representative-1000-e3000-mixed',
    outcome: 'completed',
    timeoutMs: 30_000,
    failure: null,
    phasesMs: {
      fixtureGeneration: 1,
      semanticInput: 2,
      workerPreparation: 3,
      layoutWall: 4,
      validation: 5,
    },
    input: {
      nodes: 1_000,
      edges: 3_000,
      weaklyConnectedComponents: 53,
      isolatedNodes: 50,
      maximumComponentNodes: 600,
      maximumComponentEdges: 2_100,
    },
    geometry: {
      width: 100,
      height: 200,
      nodes: 1_000,
      ports: 6_000,
      edges: 3_000,
      sections: 3_000,
      points: 9_000,
      pathCharacters: 12_000,
      geometryWeight: 13_000,
    },
    identity: { nodeIdsMatched: true, directedEdgesMatched: true },
    memory: {
      beforeLayoutBytes: 10,
      afterLayoutBytes: 20,
      afterResetBytes: null,
    },
    worker: {
      beforeResetKind: 'already-reset',
      afterResetKind: 'reset',
      afterResetRejectedOperations: 0,
      isResetAfter: true,
    },
  };
}

describe('connections browser Worker feasibility boundary', () => {
  it('decodes a complete measured case', () => {
    expect(decodeBrowserWorkerFeasibilityCaseResult(validResult())).toEqual(
      validResult(),
    );
  });

  it('rejects an unbounded or ambiguous result', () => {
    expect(() =>
      decodeBrowserWorkerFeasibilityCaseResult({
        ...validResult(),
        outcome: 'running',
      }),
    ).toThrow('outcome must be completed, failed, or timeout');
    expect(() =>
      decodeBrowserWorkerFeasibilityCaseResult({
        ...validResult(),
        timeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow('timeoutMs must be a finite non-negative number');
  });

  it('keeps every required failed browser case as raw non-passing evidence', async () => {
    const serialized = await readFile(
      'docs/benchmarks/connections-browser-worker-feasibility.json',
      'utf8',
    );
    const artifact: unknown = JSON.parse(serialized);
    if (typeof artifact !== 'object' || artifact === null) {
      throw new TypeError('browser Worker artifact must be an object');
    }
    const rawResults: unknown = Reflect.get(artifact, 'results');
    if (!Array.isArray(rawResults)) {
      throw new TypeError('browser Worker artifact results must be an array');
    }
    const results = rawResults.map(decodeBrowserWorkerFeasibilityCaseResult);

    expect(results.map(({ fixture }) => fixture)).toEqual([
      'representative-1000-e3000-mixed',
      'product-10000-existing',
      'connected-10000-e20000',
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(results.every(({ geometry }) => geometry === null)).toBe(true);
    expect(
      results.every(({ failure }) =>
        failure?.startsWith('RangeError: Maximum call stack size exceeded'),
      ),
    ).toBe(true);
  });
});
