import { describe, expect, it } from 'vitest';
import {
  activateNotesOperationLifecycle,
  captureNotesOperation,
  createStoppedNotesOperationLifecycle,
  decideNotesOperationContinuation,
  stopNotesOperationLifecycle,
  type NotesOperation,
  type NotesOperationLifecycle,
  type NotesOperationToken,
} from '@/lib/application/notes-operation-lifecycle';
import { LEGACY_NOTES_SCOPE } from '@/lib/application/notes-runtime';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const vaultScope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

function captureToken(
  lifecycle: ReturnType<typeof activateNotesOperationLifecycle>,
  operation: NotesOperation,
): NotesOperationToken {
  const decision = captureNotesOperation(lifecycle, operation);
  if (decision.kind === 'rejected') {
    throw new Error('active fixture rejected an operation');
  }
  return decision.token;
}

describe('notes operation lifecycle', () => {
  it('starts fail closed and exposes a typed stopped reason', () => {
    const stopped = createStoppedNotesOperationLifecycle(vaultScope);

    expect(stopped).toEqual({
      kind: 'stopped',
      operationEpoch: { kind: 'notes-operation-epoch', value: 0 },
      scope: vaultScope,
    });
    expect(stopped.scope).not.toBe(vaultScope);
    expect(captureNotesOperation(stopped, 'load')).toEqual({
      kind: 'rejected',
      operation: 'load',
      reason: 'lifecycle-stopped',
    });
  });

  it.each<NotesOperation>(['load', 'save', 'sync'])(
    'accepts a current %s completion in the same runtime generation',
    (operation) => {
      const stopped = Object.freeze(
        createStoppedNotesOperationLifecycle(vaultScope),
      );
      const active = activateNotesOperationLifecycle(stopped, vaultScope);
      const token = captureToken(active, operation);

      expect(decideNotesOperationContinuation(active, token)).toEqual({
        kind: 'accepted',
        operation,
      });
      expect(stopped).toEqual({
        kind: 'stopped',
        operationEpoch: { kind: 'notes-operation-epoch', value: 0 },
        scope: vaultScope,
      });
    },
  );

  it.each<NotesOperation>(['load', 'save', 'sync'])(
    'rejects a late %s completion after unmount or logout',
    (operation) => {
      const active = activateNotesOperationLifecycle(
        createStoppedNotesOperationLifecycle(vaultScope),
        vaultScope,
      );
      const token = captureToken(active, operation);

      expect(
        decideNotesOperationContinuation(
          stopNotesOperationLifecycle(active),
          token,
        ),
      ).toEqual({
        kind: 'rejected',
        operation,
        reason: 'lifecycle-stopped',
      });
    },
  );

  it('rejects an earlier operation epoch even when the Vault session is unchanged', () => {
    const firstGeneration = activateNotesOperationLifecycle(
      createStoppedNotesOperationLifecycle(vaultScope),
      vaultScope,
    );
    const token = captureToken(firstGeneration, 'save');
    const nextGeneration = activateNotesOperationLifecycle(
      firstGeneration,
      vaultScope,
    );

    expect(decideNotesOperationContinuation(nextGeneration, token)).toEqual({
      kind: 'rejected',
      operation: 'save',
      reason: 'operation-epoch-changed',
    });
  });

  it.each([
    ['account', { ...vaultScope, accountId: sessionFixtureIds.otherAccountId }],
    ['Vault', { ...vaultScope, vaultId: sessionFixtureIds.otherVaultId }],
    ['session', { ...vaultScope, sessionId: sessionFixtureIds.nextSessionId }],
    [
      'session epoch',
      { ...vaultScope, sessionEpoch: sessionFixtureIds.nextEpoch },
    ],
  ] satisfies ReadonlyArray<readonly [string, VaultNotesScope]>)(
    'rejects a completion after the %s changes',
    (_label, nextScope) => {
      const firstGeneration = activateNotesOperationLifecycle(
        createStoppedNotesOperationLifecycle(vaultScope),
        vaultScope,
      );
      const token = captureToken(firstGeneration, 'sync');
      const nextGeneration = activateNotesOperationLifecycle(
        firstGeneration,
        nextScope,
      );

      expect(decideNotesOperationContinuation(nextGeneration, token)).toEqual({
        kind: 'rejected',
        operation: 'sync',
        reason: 'scope-changed',
      });
    },
  );

  it('keeps the existing legacy runtime compatible', () => {
    const active = activateNotesOperationLifecycle(
      createStoppedNotesOperationLifecycle(LEGACY_NOTES_SCOPE),
      LEGACY_NOTES_SCOPE,
    );
    const token = captureToken(active, 'sync');

    expect(decideNotesOperationContinuation(active, token)).toEqual({
      kind: 'accepted',
      operation: 'sync',
    });
  });

  it('fails closed instead of producing an unsafe integer epoch', () => {
    const exhausted: NotesOperationLifecycle = {
      kind: 'stopped',
      operationEpoch: {
        kind: 'notes-operation-epoch',
        value: Number.MAX_SAFE_INTEGER,
      },
      scope: vaultScope,
    };

    expect(() =>
      activateNotesOperationLifecycle(exhausted, LEGACY_NOTES_SCOPE),
    ).toThrow('Notes operation epoch exhausted');
  });
});
