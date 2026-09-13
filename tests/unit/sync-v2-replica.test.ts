import { describe, expect, it } from 'vitest';
import { parseMutationId } from '@/lib/domain/id';
import type { CardRecord, PendingMutation } from '@/lib/domain/types';
import {
  initialSyncV2Checkpoint,
  planSyncV2ReplicaCommit,
} from '@/lib/sync/v2-replica';
import type { SyncV2CommitPlan } from '@/lib/sync/v2-page-application';
import { parseSyncSequence, parseSyncV2Cursor } from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';

const committedCursor = parseSyncV2Cursor(
  'sync.v2.replica.committed.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);
const otherCursor = parseSyncV2Cursor(
  'sync.v2.replica.other.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);
const newerMutationId = parseMutationId('01991f20-61d2-7000-8000-000000000006');

function completePlan(): SyncV2CommitPlan {
  const fixture = createCompatibilityFixture();
  const serverCard = fixture.response.cards[0];
  if (serverCard === undefined) throw new Error('missing server card fixture');
  return {
    previousCheckpoint: initialSyncV2Checkpoint(),
    nextCheckpoint: {
      cursor: committedCursor,
      highWatermark: parseSyncSequence(4),
    },
    changes: [
      {
        kind: 'card-upsert',
        sequence: parseSyncSequence(1),
        card: serverCard,
      },
      {
        kind: 'conflict-upsert',
        sequence: parseSyncSequence(2),
        conflict: fixture.conflict,
      },
      {
        kind: 'card-tombstone',
        sequence: parseSyncSequence(3),
        cardId: compatibilityIds.cardB,
        revision: 2,
        deletedAt: 1_789_000_000_400,
      },
      {
        kind: 'conflict-tombstone',
        sequence: parseSyncSequence(4),
        conflictId: compatibilityIds.conflict,
        cardId: compatibilityIds.cardA,
        deletedAt: 1_789_000_000_401,
      },
    ],
    receipts: [
      {
        mutationId: fixture.mutation.mutationId,
        cardId: fixture.mutation.cardId,
        appliedRevision: 2,
      },
    ],
  };
}

describe('Sync v2 local replica commit planner', () => {
  it('applies ordered upserts and tombstones with the receipt and checkpoint', () => {
    const fixture = createCompatibilityFixture();
    const decision = planSyncV2ReplicaCommit({
      plan: completePlan(),
      currentCheckpoint: initialSyncV2Checkpoint(),
      localCards: fixture.cards,
      currentMutations: [fixture.mutation],
      localConflicts: [fixture.conflict],
      sentMutations: [fixture.mutation],
    });

    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.checkpoint).toEqual(completePlan().nextCheckpoint);
    expect(decision.cards).toHaveLength(1);
    expect(decision.cards[0]).toMatchObject({
      id: compatibilityIds.cardA,
      displayId: { kind: 'official', value: 1 },
      serverRevision: 2,
    });
    expect(decision.conflicts).toEqual([]);
    expect(decision.operations).toEqual(
      expect.arrayContaining([
        { type: 'delete-mutation', cardId: compatibilityIds.cardA },
        { type: 'delete-card', cardId: compatibilityIds.cardB },
        { type: 'delete-conflict', conflictId: compatibilityIds.conflict },
      ]),
    );
  });

  it('keeps and rebases an edit saved after the acknowledged request', () => {
    const fixture = createCompatibilityFixture();
    const local = fixture.cards[0];
    const serverCard = fixture.response.cards[0];
    if (local === undefined || serverCard === undefined) {
      throw new Error('missing card fixture');
    }
    const newerCard: CardRecord = {
      ...local,
      title: '送信後の新しい編集',
      body: [{ type: 'text', text: '保持する本文' }],
      localRevision: local.localRevision + 1,
      updatedAt: local.updatedAt + 1,
    };
    const newerMutation: PendingMutation = {
      ...fixture.mutation,
      mutationId: newerMutationId,
      title: newerCard.title,
      body: newerCard.body,
      updatedAt: newerCard.updatedAt,
    };
    const decision = planSyncV2ReplicaCommit({
      plan: {
        previousCheckpoint: initialSyncV2Checkpoint(),
        nextCheckpoint: {
          cursor: committedCursor,
          highWatermark: parseSyncSequence(1),
        },
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
      },
      currentCheckpoint: initialSyncV2Checkpoint(),
      localCards: [newerCard],
      currentMutations: [newerMutation],
      localConflicts: [],
      sentMutations: [fixture.mutation],
    });

    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.cards).toEqual([
      expect.objectContaining({
        title: '送信後の新しい編集',
        body: [{ type: 'text', text: '保持する本文' }],
        serverRevision: 2,
      }),
    ]);
    expect(decision.operations).toContainEqual({
      type: 'put-mutation',
      mutation: { ...newerMutation, baseServerRevision: 2 },
    });
    expect(decision.operations).not.toContainEqual({
      type: 'delete-mutation',
      cardId: compatibilityIds.cardA,
    });
  });

  it('does not delete a locally edited card when a remote tombstone arrives', () => {
    const fixture = createCompatibilityFixture();
    const local = fixture.cards[0];
    if (local === undefined) throw new Error('missing card fixture');
    const decision = planSyncV2ReplicaCommit({
      plan: {
        previousCheckpoint: initialSyncV2Checkpoint(),
        nextCheckpoint: {
          cursor: committedCursor,
          highWatermark: parseSyncSequence(1),
        },
        changes: [
          {
            kind: 'card-tombstone',
            sequence: parseSyncSequence(1),
            cardId: local.id,
            revision: 2,
            deletedAt: local.updatedAt + 1,
          },
        ],
        receipts: [],
      },
      currentCheckpoint: initialSyncV2Checkpoint(),
      localCards: [local],
      currentMutations: [fixture.mutation],
      localConflicts: [],
      sentMutations: [],
    });

    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.cards).toEqual([local]);
    expect(decision.operations).not.toContainEqual({
      type: 'delete-card',
      cardId: local.id,
    });
  });

  it('rejects invalid receipts and stale checkpoints, but recognizes a replay', () => {
    const fixture = createCompatibilityFixture();
    const plan = completePlan();
    expect(
      planSyncV2ReplicaCommit({
        plan,
        currentCheckpoint: initialSyncV2Checkpoint(),
        localCards: fixture.cards,
        currentMutations: [fixture.mutation],
        localConflicts: [],
        sentMutations: [],
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'invalid-receipt' });

    expect(
      planSyncV2ReplicaCommit({
        plan,
        currentCheckpoint: {
          cursor: otherCursor,
          highWatermark: parseSyncSequence(3),
        },
        localCards: fixture.cards,
        currentMutations: [fixture.mutation],
        localConflicts: [],
        sentMutations: [fixture.mutation],
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'stale-checkpoint' });

    expect(
      planSyncV2ReplicaCommit({
        plan,
        currentCheckpoint: plan.nextCheckpoint,
        localCards: fixture.cards,
        currentMutations: [],
        localConflicts: [],
        sentMutations: [fixture.mutation],
      }),
    ).toMatchObject({ kind: 'already-applied' });
  });
});
