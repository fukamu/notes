export type MalformedSecurityCase = {
  readonly name: string;
  readonly value: unknown;
};

const corpusMarker = 'security-corpus-sensitive-marker';

/**
 * A deterministic, bounded set of values that can cross JSON, storage, and
 * provider boundaries without relying on random fuzzing or unbounded input.
 */
export function boundedMalformedSecurityCorpus(): readonly MalformedSecurityCase[] {
  return [
    { name: 'null', value: null },
    { name: 'boolean', value: true },
    { name: 'negative-number', value: -1 },
    { name: 'fraction', value: 1.5 },
    { name: 'array', value: [corpusMarker] },
    { name: 'empty-object', value: {} },
    {
      name: 'unknown-field',
      value: { unexpected: corpusMarker },
    },
    {
      name: 'nested-object',
      value: { value: { nested: { marker: corpusMarker } } },
    },
    { name: 'oversized-string', value: corpusMarker.repeat(1_025) },
  ];
}

export function serializedSecurityObservation(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function containsSensitiveMarker(
  observation: unknown,
  markers: readonly string[],
): boolean {
  const serialized = serializedSecurityObservation(observation);
  return markers.some((marker) => serialized.includes(marker));
}

export const securityCorpusMarker = corpusMarker;
