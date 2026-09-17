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

describe('connections full-network UI artifact', () => {
  it('records complete semantics, dynamic fit, effective localized culling, and the unmet target', async () => {
    const serialized = await readFile(
      'docs/benchmarks/connections-full-network-ui.json',
      'utf8',
    );
    const artifact: unknown = JSON.parse(serialized);
    expect(field(artifact, 'issue')).toBe(311);
    expect(field(artifact, 'branchPoint')).toBe(
      '0cb24470b85f6622dc126f8161e027c83499534f',
    );
    const fixture = field(artifact, 'fixture');
    expect(field(fixture, 'nodes')).toBe(10_000);
    expect(field(fixture, 'directedEdges')).toBe(19_999);
    const runs = field(artifact, 'runs');
    if (!Array.isArray(runs)) {
      throw new TypeError('full-network UI runs must be an array');
    }
    expect(runs.map((run) => field(run, 'project'))).toEqual([
      'chromium',
      'mobile-chromium',
    ]);
    for (const run of runs) {
      expect(finite(field(run, 'fitScale'), 'fitScale')).toBeLessThan(0.1);
      expect(
        finite(field(run, 'initialReadyMs'), 'initialReadyMs'),
      ).toBeGreaterThan(0);
      const localized = field(run, 'localizedDom');
      const wholeWorld = field(run, 'wholeWorldDom');
      expect(field(localized, 'cardButtons')).toBe(10_000);
      expect(field(localized, 'semanticEdgeItems')).toBe(19_999);
      expect(field(wholeWorld, 'cardButtons')).toBe(10_000);
      expect(field(wholeWorld, 'semanticEdgeItems')).toBe(19_999);
      expect(
        finite(field(localized, 'svgPaths'), 'localizedDom.svgPaths'),
      ).toBeLessThan(
        finite(field(wholeWorld, 'svgPaths'), 'wholeWorldDom.svgPaths'),
      );
    }
    expect(
      field(field(artifact, 'interpretation'), 'provisionalFiveSecondTarget'),
    ).toBe('not met');
  });
});
