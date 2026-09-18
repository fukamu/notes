import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION,
  accountDeletionContinuationTokenDecoder,
  accountDeletionHandoffDecoder,
  accountDeletionIdempotencyKeyDecoder,
  accountDeletionUiReducer,
  accountDeletionWireStatusDecoder,
  createAccountDeletionHandoff,
  inspectAccountDeletionHandoff,
  planAccountDeletionLocalPurgeCompleted,
  planAccountDeletionRevokeAccepted,
  planAccountDeletionServerAccepted,
  planAccountDeletionStartAccepted,
  sameAccountDeletionGeneration,
  type AccountDeletionHandoff,
} from '@/lib/application/account-deletion-handoff';
import { decodeOrThrow } from '@/lib/codec/core';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const idempotencyKey = decodeOrThrow(
  accountDeletionIdempotencyKeyDecoder,
  'I'.repeat(43),
  'fixture idempotency key',
);
const token0 = decodeOrThrow(
  accountDeletionContinuationTokenDecoder,
  `ad1.${'S'.repeat(43)}.0`,
  'fixture continuation token',
);
const token1 = decodeOrThrow(
  accountDeletionContinuationTokenDecoder,
  `ad1.${'S'.repeat(43)}.1`,
  'fixture continuation token',
);

describe('account deletion browser handoff core', () => {
  it('persists capability state before start, then orders revoke and local purge', () => {
    const starting = createAccountDeletionHandoff(generation, idempotencyKey);
    expect(starting).toEqual({
      schemaVersion: ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION,
      ...generation,
      revision: 1,
      idempotencyKey,
      kind: 'starting',
    });

    const revocation = advanced(
      planAccountDeletionStartAccepted(starting, {
        kind: 'in-progress',
        continuationToken: token0,
      }),
    );
    expect(revocation).toMatchObject({ kind: 'revoke-pending', revision: 2 });

    const purge = advanced(
      planAccountDeletionRevokeAccepted(revocation, {
        kind: 'in-progress',
        continuationToken: token1,
      }),
    );
    expect(purge).toMatchObject({ kind: 'purge-pending', revision: 3 });

    const server = advanced(planAccountDeletionLocalPurgeCompleted(purge));
    expect(server).toMatchObject({ kind: 'server-pending', revision: 4 });

    expect(
      planAccountDeletionServerAccepted(server, { kind: 'completed' }),
    ).toEqual({
      kind: 'ready-to-clear',
      generation,
      expectedRevision: 4,
      terminalStatus: 'completed',
    });
  });

  it('still requires local purge before clearing a terminal start response', () => {
    const starting = createAccountDeletionHandoff(generation, idempotencyKey);
    const purge = advanced(
      planAccountDeletionStartAccepted(starting, { kind: 'completed' }),
    );
    expect(purge.kind).toBe('purge-pending');
    expect(planAccountDeletionLocalPurgeCompleted(purge)).toEqual({
      kind: 'ready-to-clear',
      generation,
      expectedRevision: 2,
      terminalStatus: 'completed',
    });
  });

  it('rejects out-of-order transitions without changing durable state', () => {
    const starting = createAccountDeletionHandoff(generation, idempotencyKey);
    expect(planAccountDeletionLocalPurgeCompleted(starting)).toEqual({
      kind: 'rejected',
      reason: 'invalid-state',
    });
    expect(
      planAccountDeletionServerAccepted(starting, { kind: 'failed' }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-state' });
  });

  it('does not allow local purge while session revocation is waiting to retry', () => {
    const starting = createAccountDeletionHandoff(generation, idempotencyKey);
    const revocation = advanced(
      planAccountDeletionStartAccepted(starting, {
        kind: 'in-progress',
        continuationToken: token0,
      }),
    );
    const waiting = advanced(
      planAccountDeletionRevokeAccepted(revocation, {
        kind: 'retry-wait',
        retryAt: 2_000,
        continuationToken: token1,
      }),
    );
    expect(waiting).toMatchObject({
      kind: 'revoke-pending',
      revision: 3,
      server: { kind: 'retry-wait', retryAt: 2_000 },
    });
    expect(planAccountDeletionLocalPurgeCompleted(waiting)).toEqual({
      kind: 'rejected',
      reason: 'invalid-state',
    });
  });

  it('decodes external status and marker values strictly', () => {
    expect(
      accountDeletionWireStatusDecoder.decode({
        status: 'retry-wait',
        retryAt: 2_000,
        continuationToken: token0,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'retry-wait',
        retryAt: 2_000,
        continuationToken: token0,
      },
    });
    expect(
      accountDeletionWireStatusDecoder.decode({
        status: 'completed',
        continuationToken: token0,
      }).ok,
    ).toBe(false);
    expect(accountDeletionContinuationTokenDecoder.decode('ad1.bad.0').ok).toBe(
      false,
    );
    expect(accountDeletionIdempotencyKeyDecoder.decode('I'.repeat(42)).ok).toBe(
      false,
    );

    const marker = createAccountDeletionHandoff(generation, idempotencyKey);
    expect(
      accountDeletionHandoffDecoder.decode({ ...marker, extra: true }).ok,
    ).toBe(false);
    expect(
      inspectAccountDeletionHandoff({ ...marker, schemaVersion: 'future/v2' }),
    ).toEqual({ kind: 'recovery-required', reason: 'unsupported-version' });
  });

  it('compares the complete trusted session generation', () => {
    expect(sameAccountDeletionGeneration(generation, generation)).toBe(true);
    expect(
      sameAccountDeletionGeneration(generation, {
        ...generation,
        sessionId: sessionFixtureIds.nextSessionId,
      }),
    ).toBe(false);
  });

  it('reduces the confirmation, work, pending, retry, and terminal UI states', () => {
    const idle = accountDeletionUiReducer(
      { kind: 'checking' },
      { type: 'idle-loaded' },
    );
    const confirming = accountDeletionUiReducer(idle, {
      type: 'confirmation-requested',
    });
    expect(confirming).toEqual({ kind: 'confirming' });
    expect(
      accountDeletionUiReducer(confirming, { type: 'work-requested' }),
    ).toEqual({ kind: 'working' });

    const pending = accountDeletionUiReducer(
      { kind: 'working' },
      {
        type: 'run-finished',
        result: {
          kind: 'pending',
          localContent: 'retained',
          status: { kind: 'in-progress', continuationToken: token0 },
        },
      },
    );
    expect(pending).toMatchObject({
      kind: 'pending',
      localContent: 'retained',
    });
    expect(
      accountDeletionUiReducer(pending, { type: 'work-requested' }),
    ).toEqual({ kind: 'working' });
    expect(
      accountDeletionUiReducer(
        { kind: 'working' },
        {
          type: 'run-finished',
          result: { kind: 'terminal', status: 'completed' },
        },
      ),
    ).toEqual({ kind: 'terminal', status: 'completed' });
  });
});

function advanced(
  transition: ReturnType<typeof planAccountDeletionStartAccepted>,
): AccountDeletionHandoff {
  if (transition.kind !== 'advanced') {
    throw new Error(
      `expected advanced transition, received ${transition.kind}`,
    );
  }
  return transition.handoff;
}
