import { describe, expect, it } from 'vitest';
import {
  decodeClientBenchmarkDistribution,
  relativeTimingTolerance,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';

describe('client performance benchmark summaries', () => {
  it('retains raw samples and calculates nearest-rank distributions', () => {
    const summary = summarizeClientBenchmarkSamples([4, 1, 5, 2, 3]);

    expect(summary).toEqual({
      minimumMs: 1,
      medianMs: 3,
      p95Ms: 5,
      maximumMs: 5,
      samplesMs: [4, 1, 5, 2, 3],
    });
    expect(relativeTimingTolerance(summary)).toBe(2);
  });

  it('uses a 20 percent floor for stable samples', () => {
    expect(
      relativeTimingTolerance(summarizeClientBenchmarkSamples([10, 10, 11])),
    ).toBe(0.3);
    expect(
      relativeTimingTolerance(summarizeClientBenchmarkSamples([0, 0, 0])),
    ).toBe(1);
  });

  it('rejects empty, negative and non-finite observations', () => {
    expect(() => summarizeClientBenchmarkSamples([])).toThrow(RangeError);
    expect(() => summarizeClientBenchmarkSamples([-1])).toThrow(RangeError);
    expect(() => summarizeClientBenchmarkSamples([Number.NaN])).toThrow(
      RangeError,
    );
  });

  it('decodes persisted distributions at the benchmark boundary', () => {
    const valid = {
      minimumMs: 1,
      medianMs: 2,
      p95Ms: 3,
      maximumMs: 4,
      samplesMs: [2, 1, 4, 3],
    };
    const input: unknown = valid;

    expect(decodeClientBenchmarkDistribution(input)).toEqual(input);
    expect(() =>
      decodeClientBenchmarkDistribution({ ...valid, p95Ms: '3' }),
    ).toThrow(/ClientBenchmarkDistribution/u);
    expect(() =>
      decodeClientBenchmarkDistribution({ ...valid, extra: true }),
    ).toThrow(/unknown field/u);
  });
});
