import { describe, expect, it } from 'vitest';
import {
  collectLogoutPeerAcknowledgement,
  createLogoutPeerAcknowledgements,
  createLogoutPeerRuntimeState,
  createLogoutPurgeCompleted,
  createLogoutPurgeRequest,
  logoutCoordinationChannelName,
  logoutCoordinationMessageDecoder,
  logoutOwnerLockName,
  logoutPurgeFailureReasonForCoordination,
  logoutRuntimeLockName,
  parseTabInstanceId,
  transitionLogoutPeerRuntime,
} from '@/lib/application/logout-coordination';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const otherGeneration: LogoutPurgeGeneration = {
  ...generation,
  vaultId: sessionFixtureIds.otherVaultId,
};
const ownerTabId = parseTabInstanceId('00000000-0000-4000-8000-000000000001');
const nextOwnerTabId = parseTabInstanceId(
  '00000000-0000-4000-8000-000000000002',
);
const peerTabId = parseTabInstanceId('00000000-0000-4000-8000-000000000003');
const otherPeerTabId = parseTabInstanceId(
  '00000000-0000-4000-8000-000000000004',
);

describe('logout coordination protocol', () => {
  it('strictly decodes every versioned non-content message', () => {
    const request = createLogoutPurgeRequest(generation, 1, ownerTabId);
    const completed = createLogoutPurgeCompleted(generation, 1, ownerTabId);
    const peer = transitionLogoutPeerRuntime(
      transitionLogoutPeerRuntime(
        createLogoutPeerRuntimeState(generation, peerTabId),
        { type: 'message-received', input: request },
      ).state,
      { type: 'runtime-released' },
    );
    if (peer.kind !== 'accepted' || peer.action.kind !== 'send-message') {
      throw new Error('expected peer acknowledgement fixture');
    }

    for (const message of [request, peer.action.message, completed]) {
      expect(logoutCoordinationMessageDecoder.decode(message)).toEqual({
        ok: true,
        value: message,
      });
      expect(
        logoutCoordinationMessageDecoder.decode({ ...message, content: 'x' }),
      ).toMatchObject({ ok: false });
    }
    expect(
      logoutCoordinationMessageDecoder.decode({
        ...request,
        schemaVersion: 'logout-coordination/v2',
      }),
    ).toMatchObject({ ok: false });
    expect(() => parseTabInstanceId('not-a-uuid')).toThrow();
    expect(() => createLogoutPurgeRequest(generation, 0, ownerTabId)).toThrow();
  });

  it('stops once, acknowledges only after release, and re-acks duplicates', () => {
    const request = createLogoutPurgeRequest(generation, 1, ownerTabId);
    const active = createLogoutPeerRuntimeState(generation, peerTabId);
    const stopping = transitionLogoutPeerRuntime(active, {
      type: 'message-received',
      input: request,
    });
    expect(stopping).toMatchObject({
      kind: 'accepted',
      state: { kind: 'quiescing' },
      action: { kind: 'stop-runtime' },
    });
    const duplicateWhileStopping = transitionLogoutPeerRuntime(stopping.state, {
      type: 'message-received',
      input: request,
    });
    expect(duplicateWhileStopping).toMatchObject({
      kind: 'ignored',
      reason: 'duplicate-message',
    });

    const released = transitionLogoutPeerRuntime(stopping.state, {
      type: 'runtime-released',
    });
    expect(released).toMatchObject({
      kind: 'accepted',
      state: { kind: 'quiesced' },
      action: {
        kind: 'send-message',
        message: { type: 'peer-quiesced', peerTabId },
      },
    });
    const duplicateAfterRelease = transitionLogoutPeerRuntime(released.state, {
      type: 'message-received',
      input: request,
    });
    expect(duplicateAfterRelease).toMatchObject({
      kind: 'accepted',
      action: { kind: 'send-message' },
    });
  });

  it('moves a quiesced peer to a newer owner attempt and rejects stale owners', () => {
    const first = createLogoutPurgeRequest(generation, 1, ownerTabId);
    const stopping = transitionLogoutPeerRuntime(
      createLogoutPeerRuntimeState(generation, peerTabId),
      { type: 'message-received', input: first },
    );
    const quiesced = transitionLogoutPeerRuntime(stopping.state, {
      type: 'runtime-released',
    });
    const next = transitionLogoutPeerRuntime(quiesced.state, {
      type: 'message-received',
      input: createLogoutPurgeRequest(generation, 2, nextOwnerTabId),
    });
    expect(next).toMatchObject({
      kind: 'accepted',
      state: { kind: 'quiesced', attempt: 2, ownerTabId: nextOwnerTabId },
      action: { kind: 'send-message' },
    });
    expect(
      transitionLogoutPeerRuntime(next.state, {
        type: 'message-received',
        input: first,
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'stale-attempt' });
    expect(
      transitionLogoutPeerRuntime(next.state, {
        type: 'message-received',
        input: createLogoutPurgeRequest(generation, 2, ownerTabId),
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'owner-mismatch' });
  });

  it('accepts completion only from the current owner generation and attempt', () => {
    const request = createLogoutPurgeRequest(generation, 1, ownerTabId);
    const stopping = transitionLogoutPeerRuntime(
      createLogoutPeerRuntimeState(generation, peerTabId),
      { type: 'message-received', input: request },
    );
    const quiesced = transitionLogoutPeerRuntime(stopping.state, {
      type: 'runtime-released',
    });
    expect(
      transitionLogoutPeerRuntime(quiesced.state, {
        type: 'message-received',
        input: createLogoutPurgeCompleted(generation, 1, nextOwnerTabId),
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'owner-mismatch' });
    const completed = transitionLogoutPeerRuntime(quiesced.state, {
      type: 'message-received',
      input: createLogoutPurgeCompleted(generation, 1, ownerTabId),
    });
    expect(completed).toMatchObject({
      kind: 'accepted',
      state: { kind: 'completed' },
      action: { kind: 'purge-completed' },
    });
  });

  it('ignores invalid, foreign, irrelevant, and premature events', () => {
    const active = createLogoutPeerRuntimeState(generation, peerTabId);
    expect(
      transitionLogoutPeerRuntime(active, {
        type: 'message-received',
        input: { type: 'purge-request' },
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'invalid-message' });
    expect(
      transitionLogoutPeerRuntime(active, {
        type: 'message-received',
        input: createLogoutPurgeRequest(otherGeneration, 1, ownerTabId),
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'generation-mismatch' });
    expect(
      transitionLogoutPeerRuntime(active, {
        type: 'message-received',
        input: createLogoutPurgeRequest(generation, 1, peerTabId),
      }),
    ).toMatchObject({
      kind: 'accepted',
      state: { kind: 'quiescing' },
      action: { kind: 'stop-runtime' },
    });
    expect(
      transitionLogoutPeerRuntime(active, {
        type: 'message-received',
        input: createLogoutPurgeCompleted(generation, 1, ownerTabId),
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'irrelevant-message' });
    expect(
      transitionLogoutPeerRuntime(active, { type: 'runtime-released' }),
    ).toMatchObject({ kind: 'ignored', reason: 'runtime-not-quiescing' });
  });

  it.each([
    ['account', { ...generation, accountId: sessionFixtureIds.otherAccountId }],
    ['Vault', { ...generation, vaultId: sessionFixtureIds.otherVaultId }],
    ['session', { ...generation, sessionId: sessionFixtureIds.nextSessionId }],
    ['epoch', { ...generation, sessionEpoch: sessionFixtureIds.nextEpoch }],
  ] satisfies ReadonlyArray<readonly [string, LogoutPurgeGeneration]>)(
    'rejects a message from another %s generation',
    (_label, foreignGeneration) => {
      expect(
        transitionLogoutPeerRuntime(
          createLogoutPeerRuntimeState(generation, peerTabId),
          {
            type: 'message-received',
            input: createLogoutPurgeRequest(foreignGeneration, 1, ownerTabId),
          },
        ),
      ).toMatchObject({ kind: 'ignored', reason: 'generation-mismatch' });
    },
  );

  it('collects exact acknowledgements without accepting duplicates or swaps', () => {
    const state = createLogoutPeerAcknowledgements(generation, 1, ownerTabId);
    const ack = {
      ...createLogoutPurgeRequest(generation, 1, ownerTabId),
      type: 'peer-quiesced' as const,
      peerTabId,
    };
    const accepted = collectLogoutPeerAcknowledgement(state, ack);
    expect(accepted).toMatchObject({
      kind: 'accepted',
      acknowledgements: { peerTabIds: [peerTabId] },
    });
    expect(
      collectLogoutPeerAcknowledgement(accepted.acknowledgements, ack),
    ).toMatchObject({
      kind: 'ignored',
      reason: 'duplicate-acknowledgement',
    });
    for (const [message, reason] of [
      [{}, 'invalid-message'],
      [
        createLogoutPurgeRequest(generation, 1, ownerTabId),
        'irrelevant-message',
      ],
      [{ ...ack, vaultId: otherGeneration.vaultId }, 'generation-mismatch'],
      [{ ...ack, attempt: 2 }, 'attempt-mismatch'],
      [{ ...ack, ownerTabId: nextOwnerTabId }, 'owner-mismatch'],
      [{ ...ack, peerTabId: ownerTabId }, 'self-acknowledgement'],
    ] as const) {
      expect(collectLogoutPeerAcknowledgement(state, message)).toMatchObject({
        kind: 'ignored',
        reason,
      });
    }
    const next = collectLogoutPeerAcknowledgement(accepted.acknowledgements, {
      ...ack,
      peerTabId: otherPeerTabId,
    });
    expect(next).toMatchObject({
      kind: 'accepted',
      acknowledgements: { peerTabIds: [peerTabId, otherPeerTabId] },
    });
    expect(() =>
      createLogoutPeerAcknowledgements(generation, 0, ownerTabId),
    ).toThrow();
  });

  it('uses Vault-wide names and maps every platform failure fail-closed', () => {
    for (const name of [
      logoutCoordinationChannelName(generation),
      logoutRuntimeLockName(generation),
      logoutOwnerLockName(generation),
    ]) {
      expect(name).toContain(generation.accountId);
      expect(name).toContain(generation.vaultId);
      expect(name).not.toContain(generation.sessionId);
    }
    expect(logoutPurgeFailureReasonForCoordination('contended')).toBe(
      'blocked',
    );
    expect(logoutPurgeFailureReasonForCoordination('timeout')).toBe('timeout');
    expect(logoutPurgeFailureReasonForCoordination('adapter-failure')).toBe(
      'adapter-failure',
    );
    expect(
      logoutPurgeFailureReasonForCoordination('unsupported-capability'),
    ).toBe('unsupported-capability');
  });
});
