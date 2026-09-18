import { decodeTelemetryEvent, type TelemetryEvent } from './core';
import type { TelemetrySink } from './public';

export type FakeTelemetrySink = Readonly<{
  sink: TelemetrySink;
  records(): readonly TelemetryEvent[];
}>;

export function createFakeTelemetrySink(
  input: { readonly failAfterRecords?: number } = {},
): FakeTelemetrySink {
  const records: TelemetryEvent[] = [];
  return {
    sink: {
      record(event) {
        if (
          input.failAfterRecords !== undefined &&
          records.length >= input.failAfterRecords
        ) {
          throw new Error('synthetic telemetry sink failure');
        }
        records.push(decodeTelemetryEvent(event));
        return { kind: 'buffered' };
      },
    },
    records: () => [...records],
  };
}
