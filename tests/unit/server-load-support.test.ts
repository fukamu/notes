import { describe, expect, it } from 'vitest';
import {
  authorizeLocalServerLoad,
  evaluateServerLoadObservation,
  type ServerLoadObservation,
} from '@/tests/benchmarks/server-load-support';

function normalPollObservation(
  overrides: Partial<ServerLoadObservation> = {},
): ServerLoadObservation {
  return {
    scenario: 'normal-poll',
    logicalRequests: 1_000,
    httpAttempts: 1_000,
    successfulResponses: 1_000,
    unavailableResponses: 0,
    maximumInFlight: 1_000,
    handlerInstances: 1,
    uniqueVaults: 1_000,
    uniquePartitions: 16,
    tenantViolations: 0,
    applicationCalls: 1_000,
    uniqueMutationCommits: 0,
    mutationReplays: 0,
    objectReads: 0,
    objectWrites: 0,
    kmsDecryptions: 0,
    kmsEncryptions: 0,
    durationMs: 50_000,
    observedHeapDeltaBytes: -1,
    observedRssDeltaBytes: 1,
    ...overrides,
  };
}

describe('local server load policy', () => {
  it('allows only an in-process fake target without credentials', () => {
    expect(
      authorizeLocalServerLoad({
        mode: 'local-fake',
        targetUrl: undefined,
        credential: undefined,
      }),
    ).toEqual({ kind: 'authorized', executionMode: 'local-fake' });
    expect(
      authorizeLocalServerLoad({
        mode: 'staging',
        targetUrl: 'https://staging.example',
        credential: 'secret',
      }),
    ).toEqual({
      kind: 'rejected',
      reasons: [
        'unsupported-mode',
        'remote-target-present',
        'credential-present',
      ],
    });
  });

  it('gates deterministic correctness without imposing a wall-clock threshold', () => {
    expect(evaluateServerLoadObservation(normalPollObservation())).toEqual({
      kind: 'accepted',
      scenario: 'normal-poll',
    });
    expect(
      evaluateServerLoadObservation(
        normalPollObservation({ tenantViolations: 1 }),
      ),
    ).toMatchObject({
      kind: 'rejected',
      violations: ['tenantViolations: expected 0, observed 1'],
    });
  });

  it('rejects object or KMS work on a no-change poll', () => {
    expect(
      evaluateServerLoadObservation(
        normalPollObservation({ objectReads: 1, kmsDecryptions: 1 }),
      ),
    ).toMatchObject({
      kind: 'rejected',
      violations: [
        'objectReads: expected 0, observed 1',
        'kmsDecryptions: expected 0, observed 1',
      ],
    });
  });
});
