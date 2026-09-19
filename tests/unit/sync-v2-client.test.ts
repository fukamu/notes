import { describe, expect, it, vi } from 'vitest';
import {
  createSyncV2Client,
  type SyncV2Transport,
} from '@/lib/application/sync-v2-client';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { SyncV2CommitPlan } from '@/lib/sync/v2-page-application';
import {
  initialSyncV2Checkpoint,
  type SyncV2ReplicaCommitResult,
  type SyncV2ReplicaRepository,
} from '@/lib/sync/v2-replica';
import {
  parseSyncSequence,
  parseSyncV2Cursor,
  SYNC_V2_VERSION,
  type SyncV2Response,
} from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const scope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

type SyncV2RequestWire = Parameters<
  SyncV2Transport<VaultNotesScope>['send']
>[0];

const pageCursor = parseSyncV2Cursor(
  'sync.v2.client.page.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);
const committedCursor = parseSyncV2Cursor(
  'sync.v2.client.committed.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);

async function executeCommit(
  commit: () => Promise<SyncV2ReplicaCommitResult>,
): Promise<SyncV2ReplicaCommitResult> {
  return commit();
}

function pages(): readonly [SyncV2Response, SyncV2Response] {
  const fixture = createCompatibilityFixture();
  const serverCard = fixture.response.cards[0];
  if (serverCard === undefined) throw new Error('missing server card fixture');
  return [
    {
      version: SYNC_V2_VERSION,
      highWatermark: parseSyncSequence(2),
      changes: [
        {
          kind: 'card-upsert',
          sequence: parseSyncSequence(1),
          card: serverCard,
        },
      ],
      receipts: [
        {
          mutationId: fixture.mutation.mutationId,
          cardId: fixture.mutation.cardId,
          appliedRevision: 2,
        },
      ],
      page: { kind: 'more', nextCursor: pageCursor },
    },
    {
      version: SYNC_V2_VERSION,
      highWatermark: parseSyncSequence(2),
      changes: [
        {
          kind: 'conflict-upsert',
          sequence: parseSyncSequence(2),
          conflict: fixture.conflict,
        },
      ],
      receipts: [
        {
          mutationId: fixture.mutation.mutationId,
          cardId: fixture.mutation.cardId,
          appliedRevision: 2,
        },
      ],
      page: { kind: 'complete', nextCursor: committedCursor },
    },
  ];
}

function createReplica(input?: {
  readonly apply?: SyncV2ReplicaRepository<VaultNotesScope>['applyCommit'];
}) {
  const fixture = createCompatibilityFixture();
  const applyCommit = vi.fn(
    input?.apply ??
      (async (plan: SyncV2CommitPlan) => ({
        kind: 'applied' as const,
        checkpoint: plan.nextCheckpoint,
        cards: fixture.cards,
        conflicts: [fixture.conflict],
      })),
  );
  const replica: SyncV2ReplicaRepository<VaultNotesScope> = {
    scope,
    loadCheckpoint: vi.fn(async () => initialSyncV2Checkpoint()),
    applyCommit,
  };
  return { replica, applyCommit };
}

describe('Sync v2 client page orchestration', () => {
  it('sends the same mutations across pages and commits only the terminal plan', async () => {
    const fixture = createCompatibilityFixture();
    const responses = [...pages()];
    const send = vi.fn(async (_request: SyncV2RequestWire) => {
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected page request');
      return response;
    });
    const transport: SyncV2Transport<VaultNotesScope> = { scope, send };
    const { replica, applyCommit } = createReplica();
    const client = createSyncV2Client({ scope, transport, replica });

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit,
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      cards: fixture.cards,
      conflicts: [fixture.conflict],
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      cursor: null,
      mutations: [{ mutationId: fixture.mutation.mutationId }],
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      cursor: pageCursor,
      mutations: [{ mutationId: fixture.mutation.mutationId }],
    });
    expect(applyCommit).toHaveBeenCalledOnce();
    expect(applyCommit.mock.calls[0]?.[0]).toMatchObject({
      previousCheckpoint: initialSyncV2Checkpoint(),
      nextCheckpoint: {
        cursor: committedCursor,
        highWatermark: 2,
      },
      changes: [{ kind: 'card-upsert' }, { kind: 'conflict-upsert' }],
    });
  });

  it('collects more than one 500-change page before committing the complete replica', async () => {
    const fixture = createCompatibilityFixture();
    const serverCard = fixture.response.cards[0];
    if (serverCard === undefined)
      throw new Error('missing server card fixture');
    const highWatermark = parseSyncSequence(501);
    const changes = Array.from({ length: 501 }, (_, index) => ({
      kind: 'card-upsert' as const,
      sequence: parseSyncSequence(index + 1),
      card: { ...serverCard, revision: index + 1 },
    }));
    const responses: SyncV2Response[] = [
      {
        version: SYNC_V2_VERSION,
        highWatermark,
        changes: changes.slice(0, 500),
        receipts: [],
        page: { kind: 'more', nextCursor: pageCursor },
      },
      {
        version: SYNC_V2_VERSION,
        highWatermark,
        changes: changes.slice(500),
        receipts: [],
        page: { kind: 'complete', nextCursor: committedCursor },
      },
    ];
    const send = vi.fn(async (_request: SyncV2RequestWire) => {
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected page request');
      return response;
    });
    const { replica, applyCommit } = createReplica();
    const client = createSyncV2Client({
      scope,
      transport: { scope, send },
      replica,
    });

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [],
        isCurrent: () => true,
        executeCommit,
      }),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(send).toHaveBeenCalledTimes(2);
    expect(applyCommit).toHaveBeenCalledOnce();
    expect(applyCommit.mock.calls[0]?.[0].changes).toHaveLength(501);
    expect(applyCommit.mock.calls[0]?.[0]).toMatchObject({
      nextCheckpoint: { cursor: committedCursor, highWatermark: 501 },
    });
  });

  it('does not commit a malformed intermediate page', async () => {
    const fixture = createCompatibilityFixture();
    const transport: SyncV2Transport<VaultNotesScope> = {
      scope,
      send: vi.fn(async () => ({ ...pages()[0], changes: null })),
    };
    const { replica, applyCommit } = createReplica();
    const client = createSyncV2Client({ scope, transport, replica });

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'malformed-page' });
    expect(applyCommit).not.toHaveBeenCalled();
  });

  it('keeps the checkpoint uncommitted after a lost later response and retries from it', async () => {
    const fixture = createCompatibilityFixture();
    const firstAttemptSend = vi
      .fn<SyncV2Transport<VaultNotesScope>['send']>()
      .mockResolvedValueOnce(pages()[0])
      .mockRejectedValueOnce(new Error('response lost'));
    const { replica, applyCommit } = createReplica();
    const firstClient = createSyncV2Client({
      scope,
      transport: { scope, send: firstAttemptSend },
      replica,
    });

    await expect(
      firstClient.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit,
      }),
    ).rejects.toThrow('response lost');
    expect(applyCommit).not.toHaveBeenCalled();

    const retryResponses = [...pages()];
    const retrySend = vi.fn(async (_request: SyncV2RequestWire) => {
      const response = retryResponses.shift();
      if (response === undefined) throw new Error('unexpected retry page');
      return response;
    });
    const retryClient = createSyncV2Client({
      scope,
      transport: { scope, send: retrySend },
      replica,
    });
    await expect(
      retryClient.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit,
      }),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(retrySend.mock.calls[0]?.[0]?.cursor).toBeNull();
    expect(applyCommit).toHaveBeenCalledOnce();
  });

  it('cancels after a response when the session operation epoch changes', async () => {
    const fixture = createCompatibilityFixture();
    let current = true;
    const transport: SyncV2Transport<VaultNotesScope> = {
      scope,
      send: vi.fn(async () => {
        current = false;
        return pages()[0];
      }),
    };
    const { replica, applyCommit } = createReplica();
    const client = createSyncV2Client({ scope, transport, replica });

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => current,
        executeCommit,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(applyCommit).not.toHaveBeenCalled();
  });

  it('delegates the terminal commit so the local effect boundary can cancel it', async () => {
    const fixture = createCompatibilityFixture();
    const responses = [...pages()];
    const transport: SyncV2Transport<VaultNotesScope> = {
      scope,
      send: vi.fn(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected page request');
        return response;
      }),
    };
    const { replica, applyCommit } = createReplica();
    const client = createSyncV2Client({ scope, transport, replica });
    const cancelCommit = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit: cancelCommit,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });

    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(applyCommit).not.toHaveBeenCalled();
  });

  it('surfaces a stale-checkpoint commit without advancing again', async () => {
    const fixture = createCompatibilityFixture();
    const responses = [...pages()];
    const transport: SyncV2Transport<VaultNotesScope> = {
      scope,
      send: vi.fn(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected page request');
        return response;
      }),
    };
    const { replica, applyCommit } = createReplica({
      apply: async () => ({
        kind: 'rejected',
        reason: 'stale-checkpoint',
        checkpoint: initialSyncV2Checkpoint(),
      }),
    });
    const client = createSyncV2Client({ scope, transport, replica });

    await expect(
      client.synchronize({
        deviceId: compatibilityIds.device,
        sentMutations: [fixture.mutation],
        isCurrent: () => true,
        executeCommit,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'stale-checkpoint' });
    expect(applyCommit).toHaveBeenCalledOnce();
  });
});
