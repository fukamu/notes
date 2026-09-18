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

describe('connections Canvas edge artifact', () => {
  it('records complete semantics, reduced visual DOM, and unmet product targets', async () => {
    const serialized = await readFile(
      'docs/benchmarks/connections-canvas-edge-layer.json',
      'utf8',
    );
    const artifact: unknown = JSON.parse(serialized);
    expect(field(artifact, 'issue')).toBe(321);
    expect(field(artifact, 'branchPoint')).toBe(
      '80832372fc04eba3429ffa9bc5b3ae9d25e86521',
    );
    const fixture = field(artifact, 'fixture');
    expect(field(fixture, 'nodes')).toBe(10_000);
    expect(field(fixture, 'directedEdges')).toBe(19_999);
    const runs = field(artifact, 'runs');
    if (!Array.isArray(runs)) {
      throw new TypeError('Canvas edge runs must be an array');
    }
    expect(runs.map((run) => field(run, 'project'))).toEqual([
      'chromium',
      'mobile-chromium',
    ]);
    for (const run of runs) {
      expect(
        finite(field(run, 'initialReadyMs'), 'initialReadyMs'),
      ).toBeGreaterThan(5_000);
      const canvas = field(run, 'canvas');
      expect(
        finite(field(canvas, 'localizedDrawMs'), 'localizedDrawMs'),
      ).toBeLessThan(1);
      expect(
        finite(field(canvas, 'wholeWorldDrawMs'), 'wholeWorldDrawMs'),
      ).toBeGreaterThan(50);
      const localized = field(run, 'localizedDom');
      const wholeWorld = field(run, 'wholeWorldDom');
      for (const dom of [localized, wholeWorld]) {
        expect(field(dom, 'cardButtons')).toBe(10_000);
        expect(field(dom, 'semanticEdgeItems')).toBe(19_999);
        expect(field(dom, 'svgPaths')).toBe(0);
        expect(field(dom, 'canvasElements')).toBe(1);
      }
    }
    const interpretation = field(artifact, 'interpretation');
    expect(field(interpretation, 'provisionalFiveSecondReadyTarget')).toBe(
      'not met',
    );
    expect(
      field(interpretation, 'provisionalFiftyMillisecondWholeWorldDrawTarget'),
    ).toBe('not met');
  });
});
