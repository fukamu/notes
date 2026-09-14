import type { TelemetryEvent, TelemetryEventPlan } from './core';

export type TelemetrySink = {
  /**
   * Production adapters must buffer synchronously and export outside the
   * request's correctness path. Event fields are a fixed, decoded vocabulary.
   */
  record(
    event: TelemetryEvent,
  ): { readonly kind: 'buffered' } | { readonly kind: 'dropped' };
};

export type TelemetryDelivery =
  | { readonly kind: 'recorded' }
  | {
      readonly kind: 'dropped';
      readonly reason: 'invalid-event' | 'sink-rejected' | 'sink-failure';
    };

export const noOpTelemetrySink: TelemetrySink = {
  record: () => ({ kind: 'buffered' }),
};

export function recordTelemetrySafely(
  sink: TelemetrySink,
  plan: TelemetryEventPlan,
): TelemetryDelivery {
  if (plan.kind === 'rejected') {
    return { kind: 'dropped', reason: 'invalid-event' };
  }
  try {
    return sink.record(plan.event).kind === 'buffered'
      ? { kind: 'recorded' }
      : { kind: 'dropped', reason: 'sink-rejected' };
  } catch {
    return { kind: 'dropped', reason: 'sink-failure' };
  }
}
