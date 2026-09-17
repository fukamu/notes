import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite ${label}`);
  }
  return value;
}

describe('connections semantic-list product evidence', () => {
  it('records complete semantics, bounded native lists, and the remaining performance gap', async () => {
    const artifact = record(
      JSON.parse(
        await readFile(
          'docs/benchmarks/connections-semantic-lists.json',
          'utf8',
        ),
      ) as unknown,
      'artifact',
    );
    const fixture = record(artifact.fixture, 'fixture');
    expect(fixture.nodes).toBe(10_000);
    expect(fixture.edges).toBe(19_999);
    const measurements = artifact.measurements;
    if (!Array.isArray(measurements)) throw new Error('Expected measurements');
    expect(measurements).toHaveLength(4);
    for (const value of measurements) {
      const measurement = record(value, 'measurement');
      expect(number(measurement.closedSemanticListItems, 'closed items')).toBe(
        0,
      );
      expect(number(measurement.maximumCardListItems, 'card page size')).toBe(
        50,
      );
      expect(number(measurement.maximumEdgeListItems, 'edge page size')).toBe(
        50,
      );
      expect(number(measurement.localizedDescendants, 'localized DOM')).toBe(
        10_005,
      );
      expect(number(measurement.wholeWorldDescendants, 'whole-world DOM')).toBe(
        30_003,
      );
      expect(
        number(measurement.initialReadyMs, 'initial ready'),
      ).toBeGreaterThan(5_000);
    }
    const decision = record(artifact.decision, 'decision');
    expect(decision.semanticDom).toContain('accepted');
    expect(decision.overallPerformance).toContain('not complete');
  });
});
