import {
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  type Decoder,
} from '@/lib/codec/core';

export type ClientBenchmarkDistribution = Readonly<{
  minimumMs: number;
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
  samplesMs: readonly number[];
}>;

const durationDecoder: Decoder<number> = {
  decode(input, path = []) {
    return typeof input === 'number' && Number.isFinite(input) && input >= 0
      ? { ok: true, value: input }
      : {
          ok: false,
          issues: [{ path, reason: 'expected finite non-negative duration' }],
        };
  },
};

const clientBenchmarkDistributionDecoder = objectDecoder({
  minimumMs: durationDecoder,
  medianMs: durationDecoder,
  p95Ms: durationDecoder,
  maximumMs: durationDecoder,
  samplesMs: arrayDecoder(durationDecoder, { minLength: 1, maxLength: 1_000 }),
});

export function decodeClientBenchmarkDistribution(
  input: unknown,
): ClientBenchmarkDistribution {
  return decodeOrThrow(
    clientBenchmarkDistributionDecoder,
    input,
    'ClientBenchmarkDistribution',
  );
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(sorted: readonly number[], proportion: number): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1),
  );
  const value = sorted[index];
  if (value === undefined) throw new Error('Missing percentile sample');
  return value;
}

export function summarizeClientBenchmarkSamples(
  samples: readonly number[],
): ClientBenchmarkDistribution {
  if (
    samples.length === 0 ||
    samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    throw new RangeError(
      'Benchmark samples must contain finite non-negative durations',
    );
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  if (minimum === undefined || maximum === undefined) {
    throw new Error('Benchmark distribution unexpectedly has no samples');
  }
  return {
    minimumMs: rounded(minimum),
    medianMs: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maximumMs: rounded(maximum),
    samplesMs: samples.map(rounded),
  };
}

export function relativeTimingTolerance(
  distribution: ClientBenchmarkDistribution,
): number {
  if (distribution.medianMs === 0) return 1;
  const observedSpread =
    (distribution.p95Ms - distribution.medianMs) / distribution.medianMs;
  return rounded(Math.max(0.2, observedSpread * 3));
}
