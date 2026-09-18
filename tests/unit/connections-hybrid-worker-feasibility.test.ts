import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeBrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Reflect.get(input, key);
}

function finite(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${label} must be finite and non-negative`);
  }
  return input;
}

describe('connections hybrid Worker feasibility artifact', () => {
  it('records complete geometry and separated corridor phases for every required fixture', async () => {
    const serialized = await readFile(
      'docs/benchmarks/connections-hybrid-worker-feasibility.json',
      'utf8',
    );
    const artifact: unknown = JSON.parse(serialized);
    expect(field(artifact, 'issue')).toBe(318);
    expect(field(artifact, 'branchPoint')).toBe(
      '957e596d4a63af46d0017d13478e347101088061',
    );
    const rawResults = field(artifact, 'results');
    if (!Array.isArray(rawResults)) {
      throw new TypeError('hybrid Worker artifact results must be an array');
    }
    const results = rawResults.map((raw) => {
      const result = decodeBrowserWorkerFeasibilityCaseResult(raw);
      const timing = field(raw, 'corridorTiming');
      return {
        result,
        workerLayoutMs: finite(
          field(timing, 'workerLayoutMs'),
          'corridorTiming.workerLayoutMs',
        ),
        responseDecodeMs: finite(
          field(timing, 'responseDecodeMs'),
          'corridorTiming.responseDecodeMs',
        ),
        transferAndSchedulingMs: finite(
          field(timing, 'transferAndSchedulingMs'),
          'corridorTiming.transferAndSchedulingMs',
        ),
        curvePreparationMs: finite(
          field(raw, 'curvePreparationMs'),
          'curvePreparationMs',
        ),
      };
    });

    expect(results.map(({ result }) => result.fixture)).toEqual([
      'boundary-257-mixed',
      'representative-1000-e3000-mixed',
      'product-10000-existing',
      'connected-10000-e20000',
    ]);
    for (const {
      result,
      workerLayoutMs,
      responseDecodeMs,
      transferAndSchedulingMs,
      curvePreparationMs,
    } of results) {
      expect(result.outcome).toBe('completed');
      expect(result.geometry?.nodes).toBe(result.input.nodes);
      expect(result.geometry?.edges).toBe(result.input.edges);
      expect(result.geometry?.ports).toBe(result.input.edges * 2);
      expect(result.identity).toEqual({
        nodeIdsMatched: true,
        directedEdgesMatched: true,
      });
      expect(result.worker.isResetAfter).toBe(true);
      expect(workerLayoutMs).toBeGreaterThanOrEqual(0);
      expect(responseDecodeMs).toBeGreaterThanOrEqual(0);
      expect(transferAndSchedulingMs).toBeGreaterThanOrEqual(0);
      expect(curvePreparationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
