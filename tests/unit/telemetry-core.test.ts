import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  bucketTelemetryCount,
  bucketTelemetryDuration,
  decodeTelemetryEvent,
  planTelemetryAlert,
  planTelemetryEvent,
  telemetryMetricsForEvent,
  type TelemetryEvent,
  type TelemetryFailureCategory,
  type TelemetryOperation,
  type TelemetryOutcome,
} from '@/server/telemetry/core';
import { createFakeTelemetrySink } from '@/server/telemetry/fake';
import {
  noOpTelemetrySink,
  recordTelemetrySafely,
} from '@/server/telemetry/public';
import {
  boundedMalformedSecurityCorpus,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';

function event(input: {
  readonly operation: TelemetryOperation;
  readonly outcome: TelemetryOutcome;
  readonly failureCategory: TelemetryFailureCategory;
}): TelemetryEvent {
  const planned = planTelemetryEvent({
    ...input,
    durationBucket: 'not-measured',
    workItemsBucket: 'zero',
  });
  if (planned.kind === 'rejected') {
    throw new Error('Telemetry event fixture is incoherent');
  }
  return planned.event;
}

describe('provider-neutral telemetry core', () => {
  it('buckets durations and counts without exporting raw measurements', () => {
    expect(
      [null, 0, 9.999, 10, 99.999, 100, 999.999, 1_000].map(
        bucketTelemetryDuration,
      ),
    ).toEqual([
      { kind: 'bucketed', bucket: 'not-measured' },
      { kind: 'bucketed', bucket: 'under-10ms' },
      { kind: 'bucketed', bucket: 'under-10ms' },
      { kind: 'bucketed', bucket: '10-99ms' },
      { kind: 'bucketed', bucket: '10-99ms' },
      { kind: 'bucketed', bucket: '100-999ms' },
      { kind: 'bucketed', bucket: '100-999ms' },
      { kind: 'bucketed', bucket: '1s-or-more' },
    ]);
    expect(
      [null, 0, 1, 2, 10, 11, 100, 101, 1_000, 1_001].map(bucketTelemetryCount),
    ).toEqual([
      { kind: 'bucketed', bucket: 'not-measured' },
      { kind: 'bucketed', bucket: 'zero' },
      { kind: 'bucketed', bucket: 'one' },
      { kind: 'bucketed', bucket: '2-10' },
      { kind: 'bucketed', bucket: '2-10' },
      { kind: 'bucketed', bucket: '11-100' },
      { kind: 'bucketed', bucket: '11-100' },
      { kind: 'bucketed', bucket: '101-1000' },
      { kind: 'bucketed', bucket: '101-1000' },
      { kind: 'bucketed', bucket: 'over-1000' },
    ]);
    expect(bucketTelemetryDuration(Number.NaN)).toEqual({ kind: 'rejected' });
    expect(bucketTelemetryCount(-1)).toEqual({ kind: 'rejected' });
  });

  it('rejects incoherent states and unknown or high-cardinality fields', () => {
    expect(
      planTelemetryEvent({
        operation: 'sync-v2',
        outcome: 'success',
        failureCategory: 'dependency',
        durationBucket: 'not-measured',
        workItemsBucket: 'zero',
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'incoherent-failure-category',
    });

    for (const candidate of [
      {
        schemaVersion: 1,
        operation: securityCorpusMarker,
        outcome: 'failure',
        failureCategory: 'internal',
        durationBucket: 'not-measured',
        workItemsBucket: 'zero',
      },
      {
        schemaVersion: 1,
        operation: 'sync-v2',
        outcome: 'no-change',
        failureCategory: 'none',
        durationBucket: 'not-measured',
        workItemsBucket: 'zero',
        vaultId: '01991f20-61d2-7000-8000-000000000001',
      },
      {
        schemaVersion: 1,
        operation: 'sync-v2',
        outcome: 'failure',
        failureCategory: 'none',
        durationBucket: 'not-measured',
        workItemsBucket: 'zero',
      },
    ]) {
      expect(() => decodeTelemetryEvent(candidate)).toThrow(
        BoundaryDecodeError,
      );
    }
    for (const malformed of boundedMalformedSecurityCorpus()) {
      expect(
        () => decodeTelemetryEvent(malformed.value),
        malformed.name,
      ).toThrow(BoundaryDecodeError);
    }
  });

  it('derives fixed metric names and bounded labels only', () => {
    const metrics = telemetryMetricsForEvent(
      event({
        operation: 'auth-email-otp',
        outcome: 'denied',
        failureCategory: 'authentication',
      }),
    );
    expect(metrics.map(({ name }) => name)).toEqual([
      'boundary-outcome-total',
      'boundary-duration-bucket-total',
      'boundary-work-items-bucket-total',
    ]);
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain(securityCorpusMarker);
    expect(serialized).not.toMatch(
      /accountId|vaultId|cardId|token|cookie|title|body/i,
    );
  });

  it('routes alert candidates without deciding provider thresholds', () => {
    expect(
      planTelemetryAlert(
        event({
          operation: 'auth-google-oidc',
          outcome: 'denied',
          failureCategory: 'authentication',
        }),
      ),
    ).toEqual({ kind: 'none' });
    expect(
      planTelemetryAlert(
        event({
          operation: 'sync-v2',
          outcome: 'locked',
          failureCategory: 'billing',
        }),
      ),
    ).toEqual({
      kind: 'candidate',
      signal: 'billing-lock',
      route: 'billing-operations',
      threshold: { kind: 'decision-required' },
    });
    expect(
      planTelemetryAlert(
        event({
          operation: 'storage-encrypted-object',
          outcome: 'failure',
          failureCategory: 'integrity',
        }),
      ),
    ).toMatchObject({
      kind: 'candidate',
      signal: 'integrity-failure',
      route: 'security-operations',
    });
    expect(
      planTelemetryAlert(
        event({
          operation: 'billing-stripe',
          outcome: 'failure',
          failureCategory: 'dependency',
        }),
      ),
    ).toMatchObject({
      kind: 'candidate',
      signal: 'billing-provider-failure',
      route: 'billing-operations',
    });
    expect(
      planTelemetryAlert(
        event({
          operation: 'sync-v2',
          outcome: 'failure',
          failureCategory: 'dependency',
        }),
      ),
    ).toMatchObject({
      kind: 'candidate',
      signal: 'service-failure',
      route: 'service-operations',
    });
  });

  it('keeps sink order and isolates export failure from the caller', () => {
    const succeeded = event({
      operation: 'sync-v2',
      outcome: 'success',
      failureCategory: 'none',
    });
    const denied = event({
      operation: 'auth-email-otp',
      outcome: 'denied',
      failureCategory: 'authentication',
    });
    const failed = event({
      operation: 'crypto-envelope',
      outcome: 'failure',
      failureCategory: 'dependency',
    });
    const noChange = event({
      operation: 'sync-v2',
      outcome: 'no-change',
      failureCategory: 'none',
    });
    const ordered = [succeeded, denied, failed, noChange];
    const fake = createFakeTelemetrySink();

    for (const item of ordered) {
      expect(
        recordTelemetrySafely(fake.sink, {
          kind: 'accepted',
          event: item,
        }),
      ).toEqual({ kind: 'recorded' });
    }
    expect(fake.records()).toEqual(ordered);

    const failure = createFakeTelemetrySink({ failAfterRecords: 0 });
    expect(
      recordTelemetrySafely(failure.sink, {
        kind: 'accepted',
        event: succeeded,
      }),
    ).toEqual({ kind: 'dropped', reason: 'sink-failure' });
    expect(failure.records()).toEqual([]);
    expect(
      recordTelemetrySafely(
        { record: () => ({ kind: 'dropped' }) },
        { kind: 'accepted', event: failed },
      ),
    ).toEqual({ kind: 'dropped', reason: 'sink-rejected' });
    expect(
      recordTelemetrySafely(noOpTelemetrySink, {
        kind: 'accepted',
        event: failed,
      }),
    ).toEqual({ kind: 'recorded' });
    expect(
      recordTelemetrySafely(fake.sink, {
        kind: 'rejected',
        reason: 'incoherent-failure-category',
      }),
    ).toEqual({ kind: 'dropped', reason: 'invalid-event' });
  });
});
