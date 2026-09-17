import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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

describe('connections card-windowing product evidence', () => {
  it('records complete membership, bounded card DOM, and the measured full-fit blocker', async () => {
    const artifact: unknown = JSON.parse(
      await readFile('docs/benchmarks/connections-card-windowing.json', 'utf8'),
    );
    expect(field(artifact, 'issue')).toBe(325);
    expect(field(artifact, 'branchPoint')).toBe(
      'b96a1a024d9aa4b71460d82b5e8e51daca4816d6',
    );
    const fixture = field(artifact, 'fixture');
    expect(field(fixture, 'nodes')).toBe(10_000);
    expect(field(fixture, 'directedEdges')).toBe(19_999);
    const runs = field(artifact, 'runs');
    if (!Array.isArray(runs)) throw new TypeError('Expected recorded runs');
    expect(runs.map((run) => field(run, 'project'))).toEqual([
      'chromium',
      'mobile-chromium',
    ]);
    for (const run of runs) {
      expect(
        finite(field(run, 'initialReadyMs'), 'initial ready'),
      ).toBeLessThan(5_000);
      for (const key of ['localizedDom', 'wholeWorldDom']) {
        const dom = field(run, key);
        expect(finite(field(dom, 'cardButtons'), `${key} cards`)).toBeLessThan(
          10_000,
        );
        expect(field(dom, 'canvasElements')).toBe(2);
      }
      const continuous = field(run, 'continuousWholeWorld');
      expect(field(continuous, 'samples')).toBe(30);
      expect(
        finite(field(continuous, 'frameP95Ms'), 'full-fit frame p95'),
      ).toBeGreaterThan(50);
      const edge = field(run, 'edgeCanvas');
      const card = field(run, 'cardCanvas');
      expect(
        finite(field(edge, 'continuousWholeWorldP95Ms'), 'edge p95'),
      ).toBeGreaterThan(
        finite(field(card, 'continuousWholeWorldP95Ms'), 'card p95'),
      );
    }
    const interpretation = field(artifact, 'interpretation');
    expect(field(interpretation, 'membership')).toBe('complete');
    expect(field(interpretation, 'provisionalFiveSecondReadyTarget')).toContain(
      'met',
    );
    expect(
      field(
        interpretation,
        'provisionalFiftyMillisecondContinuousWholeWorldTarget',
      ),
    ).toBe('not met');
  });
});
