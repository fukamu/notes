import {
  BoundaryDecodeError,
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  unionDecoder,
} from '../../lib/codec/core';

export const telemetryOperations = [
  'auth-google-oidc',
  'auth-email-otp',
  'sync-v2',
  'billing-stripe',
  'storage-encrypted-object',
  'crypto-envelope',
] as const;

export const telemetryOutcomes = [
  'success',
  'no-change',
  'replayed',
  'denied',
  'locked',
  'failure',
] as const;

export const telemetryFailureCategories = [
  'none',
  'authentication',
  'authorization',
  'invalid-input',
  'billing',
  'quota',
  'conflict',
  'dependency',
  'integrity',
  'internal',
] as const;

export const telemetryDurationBuckets = [
  'not-measured',
  'under-10ms',
  '10-99ms',
  '100-999ms',
  '1s-or-more',
] as const;

export const telemetryCountBuckets = [
  'not-measured',
  'zero',
  'one',
  '2-10',
  '11-100',
  '101-1000',
  'over-1000',
] as const;

export type TelemetryOperation = (typeof telemetryOperations)[number];
export type TelemetryOutcome = (typeof telemetryOutcomes)[number];
export type TelemetryFailureCategory =
  (typeof telemetryFailureCategories)[number];
export type TelemetryDurationBucket = (typeof telemetryDurationBuckets)[number];
export type TelemetryCountBucket = (typeof telemetryCountBuckets)[number];

export type TelemetryEvent = Readonly<{
  schemaVersion: 1;
  operation: TelemetryOperation;
  outcome: TelemetryOutcome;
  failureCategory: TelemetryFailureCategory;
  durationBucket: TelemetryDurationBucket;
  workItemsBucket: TelemetryCountBucket;
}>;

export type TelemetryEventPlan =
  | { readonly kind: 'accepted'; readonly event: TelemetryEvent }
  | {
      readonly kind: 'rejected';
      readonly reason: 'incoherent-failure-category';
    };

export function planTelemetryEvent(
  input: Omit<TelemetryEvent, 'schemaVersion'>,
): TelemetryEventPlan {
  const succeeded =
    input.outcome === 'success' ||
    input.outcome === 'no-change' ||
    input.outcome === 'replayed';
  if (succeeded !== (input.failureCategory === 'none')) {
    return { kind: 'rejected', reason: 'incoherent-failure-category' };
  }
  return {
    kind: 'accepted',
    event: { schemaVersion: 1, ...input },
  };
}

export type TelemetryBucketResult<TBucket> =
  | { readonly kind: 'bucketed'; readonly bucket: TBucket }
  | { readonly kind: 'rejected' };

export function bucketTelemetryDuration(
  durationMs: unknown,
): TelemetryBucketResult<TelemetryDurationBucket> {
  if (durationMs === null) {
    return { kind: 'bucketed', bucket: 'not-measured' };
  }
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return { kind: 'rejected' };
  }
  if (durationMs < 10) return { kind: 'bucketed', bucket: 'under-10ms' };
  if (durationMs < 100) return { kind: 'bucketed', bucket: '10-99ms' };
  if (durationMs < 1_000) return { kind: 'bucketed', bucket: '100-999ms' };
  return { kind: 'bucketed', bucket: '1s-or-more' };
}

export function bucketTelemetryCount(
  count: unknown,
): TelemetryBucketResult<TelemetryCountBucket> {
  if (count === null) {
    return { kind: 'bucketed', bucket: 'not-measured' };
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return { kind: 'rejected' };
  }
  if (count === 0) return { kind: 'bucketed', bucket: 'zero' };
  if (count === 1) return { kind: 'bucketed', bucket: 'one' };
  if (count <= 10) return { kind: 'bucketed', bucket: '2-10' };
  if (count <= 100) return { kind: 'bucketed', bucket: '11-100' };
  if (count <= 1_000) return { kind: 'bucketed', bucket: '101-1000' };
  return { kind: 'bucketed', bucket: 'over-1000' };
}

export type TelemetryMetric =
  | Readonly<{
      name: 'boundary-outcome-total';
      value: 1;
      labels: Readonly<{
        operation: TelemetryOperation;
        outcome: TelemetryOutcome;
        failureCategory: TelemetryFailureCategory;
      }>;
    }>
  | Readonly<{
      name: 'boundary-duration-bucket-total';
      value: 1;
      labels: Readonly<{
        operation: TelemetryOperation;
        durationBucket: TelemetryDurationBucket;
      }>;
    }>
  | Readonly<{
      name: 'boundary-work-items-bucket-total';
      value: 1;
      labels: Readonly<{
        operation: TelemetryOperation;
        workItemsBucket: TelemetryCountBucket;
      }>;
    }>;

export function telemetryMetricsForEvent(
  event: TelemetryEvent,
): readonly TelemetryMetric[] {
  return [
    {
      name: 'boundary-outcome-total',
      value: 1,
      labels: {
        operation: event.operation,
        outcome: event.outcome,
        failureCategory: event.failureCategory,
      },
    },
    {
      name: 'boundary-duration-bucket-total',
      value: 1,
      labels: {
        operation: event.operation,
        durationBucket: event.durationBucket,
      },
    },
    {
      name: 'boundary-work-items-bucket-total',
      value: 1,
      labels: {
        operation: event.operation,
        workItemsBucket: event.workItemsBucket,
      },
    },
  ];
}

export type TelemetryAlertPlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'candidate';
      readonly signal:
        | 'integrity-failure'
        | 'service-failure'
        | 'billing-lock'
        | 'billing-provider-failure';
      readonly route:
        | 'security-operations'
        | 'service-operations'
        | 'billing-operations';
      readonly threshold: { readonly kind: 'decision-required' };
    };

export function planTelemetryAlert(event: TelemetryEvent): TelemetryAlertPlan {
  if (event.failureCategory === 'integrity') {
    return {
      kind: 'candidate',
      signal: 'integrity-failure',
      route: 'security-operations',
      threshold: { kind: 'decision-required' },
    };
  }
  if (event.failureCategory === 'billing') {
    return {
      kind: 'candidate',
      signal: 'billing-lock',
      route: 'billing-operations',
      threshold: { kind: 'decision-required' },
    };
  }
  if (event.operation === 'billing-stripe' && event.outcome === 'failure') {
    return {
      kind: 'candidate',
      signal: 'billing-provider-failure',
      route: 'billing-operations',
      threshold: { kind: 'decision-required' },
    };
  }
  if (
    event.outcome === 'failure' &&
    (event.failureCategory === 'dependency' ||
      event.failureCategory === 'internal')
  ) {
    return {
      kind: 'candidate',
      signal: 'service-failure',
      route: 'service-operations',
      threshold: { kind: 'decision-required' },
    };
  }
  return { kind: 'none' };
}

const operationDecoder = unionDecoder(
  literalDecoder('auth-google-oidc'),
  literalDecoder('auth-email-otp'),
  literalDecoder('sync-v2'),
  literalDecoder('billing-stripe'),
  literalDecoder('storage-encrypted-object'),
  literalDecoder('crypto-envelope'),
);
const outcomeDecoder = unionDecoder(
  literalDecoder('success'),
  literalDecoder('no-change'),
  literalDecoder('replayed'),
  literalDecoder('denied'),
  literalDecoder('locked'),
  literalDecoder('failure'),
);
const failureCategoryDecoder = unionDecoder(
  literalDecoder('none'),
  literalDecoder('authentication'),
  literalDecoder('authorization'),
  literalDecoder('invalid-input'),
  literalDecoder('billing'),
  literalDecoder('quota'),
  literalDecoder('conflict'),
  literalDecoder('dependency'),
  literalDecoder('integrity'),
  literalDecoder('internal'),
);
const durationBucketDecoder = unionDecoder(
  literalDecoder('not-measured'),
  literalDecoder('under-10ms'),
  literalDecoder('10-99ms'),
  literalDecoder('100-999ms'),
  literalDecoder('1s-or-more'),
);
const countBucketDecoder = unionDecoder(
  literalDecoder('not-measured'),
  literalDecoder('zero'),
  literalDecoder('one'),
  literalDecoder('2-10'),
  literalDecoder('11-100'),
  literalDecoder('101-1000'),
  literalDecoder('over-1000'),
);

const telemetryEventDecoder = objectDecoder({
  schemaVersion: safeIntegerDecoder({ minimum: 1, maximum: 1 }),
  operation: operationDecoder,
  outcome: outcomeDecoder,
  failureCategory: failureCategoryDecoder,
  durationBucket: durationBucketDecoder,
  workItemsBucket: countBucketDecoder,
});

export function decodeTelemetryEvent(input: unknown): TelemetryEvent {
  const decoded = decodeOrThrow(telemetryEventDecoder, input, 'TelemetryEvent');
  const planned = planTelemetryEvent({
    operation: decoded.operation,
    outcome: decoded.outcome,
    failureCategory: decoded.failureCategory,
    durationBucket: decoded.durationBucket,
    workItemsBucket: decoded.workItemsBucket,
  });
  if (planned.kind === 'rejected') {
    throw new BoundaryDecodeError('TelemetryEvent', [
      {
        path: ['failureCategory'],
        reason: planned.reason,
      },
    ]);
  }
  return planned.event;
}
