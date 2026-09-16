import { describe, expect, it } from 'vitest';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';
import { parseSyncSequence } from '@/lib/sync/v2-protocol';
import { parseContentRevision } from '@/server/vault-content/records';
import {
  planSyncV2JournalCommit,
  planSyncV2JournalPage,
  type SyncV2JournalSnapshot,
} from '@/server/vault-content/sync-v2-core';
import {
  parseSyncV2MutationFingerprint,
  type SyncV2JournalCommit,
} from '@/server/vault-content/sync-v2-public';

const ids = {
  card: fixtureCardId('sync-v2-journal-card'),
  conflictA: fixtureConflictId('sync-v2-journal-conflict-a'),
  conflictB: fixtureConflictId('sync-v2-journal-conflict-b'),
  mutation: fixtureMutationId('sync-v2-journal-mutation'),
  otherMutation: fixtureMutationId('sync-v2-journal-other-mutation'),
  fingerprint: parseSyncV2MutationFingerprint(`${'a'.repeat(42)}A`),
  otherFingerprint: parseSyncV2MutationFingerprint(`${'b'.repeat(42)}A`),
  revision1: parseContentRevision(1),
  revision2: parseContentRevision(2),
  revision3: parseContentRevision(3),
  revision4: parseContentRevision(4),
} as const;

function emptySnapshot(): SyncV2JournalSnapshot {
  return {
    state: { nextDisplayId: 1, nextSequence: 1 },
    existingReceipt: undefined,
    card: undefined,
    selectedConflicts: [],
    allCardConflicts: [],
  };
}

function cardSnapshot(): SyncV2JournalSnapshot {
  return {
    ...emptySnapshot(),
    state: { nextDisplayId: 2, nextSequence: 2 },
    card: {
      cardId: ids.card,
      officialDisplayId: 1,
      revision: ids.revision1,
      updatedAt: 1_000,
    },
  };
}

function createCommand(): Extract<
  SyncV2JournalCommit,
  { readonly kind: 'card-upsert' }
> {
  return {
    kind: 'card-upsert',
    mutationId: ids.mutation,
    fingerprint: ids.fingerprint,
    cardId: ids.card,
    expectedRevision: null,
    nextRevision: ids.revision1,
    updatedAt: 1_000,
    committedAt: 1_100,
  };
}

describe('Sync v2 journal commit planning', () => {
  it('accepts only canonical SHA-256 base64url fingerprints', () => {
    expect(parseSyncV2MutationFingerprint(`${'z'.repeat(42)}A`)).toHaveLength(
      43,
    );
    for (const invalid of [
      'short',
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}B`,
    ]) {
      expect(() => parseSyncV2MutationFingerprint(invalid)).toThrow();
    }
  });

  it('allocates display ID and sequence without mutating the snapshot', () => {
    const snapshot = emptySnapshot();
    const before = structuredClone(snapshot);
    expect(planSyncV2JournalCommit(createCommand(), snapshot)).toEqual({
      kind: 'commit',
      receipt: {
        mutationId: ids.mutation,
        fingerprint: ids.fingerprint,
        cardId: ids.card,
        appliedRevision: ids.revision1,
        committedAt: 1_100,
      },
      expectedState: { nextDisplayId: 1, nextSequence: 1 },
      nextState: { nextDisplayId: 2, nextSequence: 2 },
      officialDisplayId: 1,
      changes: [
        {
          kind: 'card-upsert',
          sequence: 1,
          cardId: ids.card,
          officialDisplayId: 1,
          revision: ids.revision1,
          occurredAt: 1_000,
        },
      ],
    });
    expect(snapshot).toEqual(before);
  });

  it('replays only an identical fingerprint', () => {
    const receipt = {
      mutationId: ids.mutation,
      fingerprint: ids.fingerprint,
      cardId: ids.card,
      appliedRevision: ids.revision1,
      committedAt: 1_100,
    } as const;
    expect(
      planSyncV2JournalCommit(createCommand(), {
        ...emptySnapshot(),
        existingReceipt: receipt,
      }),
    ).toEqual({ kind: 'replayed', receipt });
    expect(
      planSyncV2JournalCommit(
        { ...createCommand(), fingerprint: ids.otherFingerprint },
        { ...emptySnapshot(), existingReceipt: receipt },
      ),
    ).toEqual({ kind: 'not-applied', reason: 'idempotency-key-reuse' });
  });

  it('requires consecutive card revisions and non-decreasing time', () => {
    const base = {
      ...createCommand(),
      expectedRevision: ids.revision1,
      nextRevision: ids.revision2,
      updatedAt: 1_001,
    };
    expect(planSyncV2JournalCommit(base, cardSnapshot())).toMatchObject({
      kind: 'commit',
      officialDisplayId: null,
      nextState: { nextDisplayId: 2, nextSequence: 3 },
    });
    expect(
      planSyncV2JournalCommit(
        { ...base, nextRevision: ids.revision3 },
        cardSnapshot(),
      ),
    ).toEqual({ kind: 'not-applied', reason: 'invalid-next-revision' });
    expect(
      planSyncV2JournalCommit({ ...base, updatedAt: 999 }, cardSnapshot()),
    ).toEqual({ kind: 'not-applied', reason: 'invalid-timeline' });
  });

  it('orders a resolved card before its exact conflict tombstones', () => {
    const snapshot = {
      ...cardSnapshot(),
      selectedConflicts: [
        {
          conflictId: ids.conflictA,
          cardId: ids.card,
          serverRevision: ids.revision1,
          createdAt: 1_010,
        },
        {
          conflictId: ids.conflictB,
          cardId: ids.card,
          serverRevision: ids.revision1,
          createdAt: 1_011,
        },
      ],
    };
    const result = planSyncV2JournalCommit(
      {
        kind: 'resolve-conflicts',
        mutationId: ids.otherMutation,
        fingerprint: ids.otherFingerprint,
        cardId: ids.card,
        expectedRevision: ids.revision1,
        nextRevision: ids.revision2,
        updatedAt: 1_100,
        committedAt: 1_100,
        conflictIds: [ids.conflictA, ids.conflictB],
      },
      snapshot,
    );
    expect(result).toMatchObject({
      kind: 'commit',
      nextState: { nextDisplayId: 2, nextSequence: 5 },
      changes: [
        { kind: 'card-upsert', sequence: 2 },
        { kind: 'conflict-tombstone', sequence: 3 },
        { kind: 'conflict-tombstone', sequence: 4 },
      ],
    });
  });

  it('rejects missing or cross-card conflicts', () => {
    const command = {
      kind: 'resolve-conflicts',
      mutationId: ids.otherMutation,
      fingerprint: ids.otherFingerprint,
      cardId: ids.card,
      expectedRevision: ids.revision1,
      nextRevision: ids.revision2,
      updatedAt: 1_100,
      committedAt: 1_100,
      conflictIds: [ids.conflictA],
    } as const;
    expect(planSyncV2JournalCommit(command, cardSnapshot())).toEqual({
      kind: 'not-applied',
      reason: 'missing-conflict',
    });
    expect(
      planSyncV2JournalCommit(command, {
        ...cardSnapshot(),
        selectedConflicts: [
          {
            conflictId: ids.conflictA,
            cardId: fixtureCardId('sync-v2-journal-other-card'),
            serverRevision: ids.revision1,
            createdAt: 1_010,
          },
        ],
      }),
    ).toEqual({ kind: 'not-applied', reason: 'conflict-card-mismatch' });
  });

  it('emits all conflict tombstones before a card tombstone', () => {
    const orderedConflictIds = [ids.conflictA, ids.conflictB].sort();
    const result = planSyncV2JournalCommit(
      {
        kind: 'card-delete',
        mutationId: ids.otherMutation,
        fingerprint: ids.otherFingerprint,
        cardId: ids.card,
        expectedRevision: ids.revision1,
        tombstoneRevision: ids.revision2,
        deletedAt: 1_100,
        committedAt: 1_100,
      },
      {
        ...cardSnapshot(),
        allCardConflicts: [
          {
            conflictId: ids.conflictB,
            cardId: ids.card,
            serverRevision: ids.revision1,
            createdAt: 1_010,
          },
          {
            conflictId: ids.conflictA,
            cardId: ids.card,
            serverRevision: ids.revision1,
            createdAt: 1_011,
          },
        ],
      },
    );
    expect(result).toMatchObject({
      kind: 'commit',
      receipt: { appliedRevision: ids.revision2 },
      changes: [
        { kind: 'conflict-tombstone', conflictId: orderedConflictIds[0] },
        { kind: 'conflict-tombstone', conflictId: orderedConflictIds[1] },
        {
          kind: 'card-tombstone',
          cardId: ids.card,
          revision: ids.revision2,
        },
      ],
    });
  });

  it('rejects unsafe allocator state before assigning identifiers', () => {
    expect(
      planSyncV2JournalCommit(createCommand(), {
        ...emptySnapshot(),
        state: { nextDisplayId: Number.MAX_SAFE_INTEGER, nextSequence: 1 },
      }),
    ).toEqual({ kind: 'not-applied', reason: 'invalid-state' });
    expect(
      planSyncV2JournalCommit(createCommand(), {
        ...emptySnapshot(),
        state: { nextDisplayId: 1, nextSequence: Number.MAX_SAFE_INTEGER },
      }),
    ).toEqual({ kind: 'not-applied', reason: 'invalid-state' });
  });
});

describe('Sync v2 journal page planning', () => {
  const change = (sequence: number) => ({
    kind: 'card-upsert' as const,
    sequence: parseSyncSequence(sequence),
    cardId: ids.card,
    officialDisplayId: 1,
    revision: ids.revision1,
    occurredAt: 1_000,
  });

  it('keeps a fixed high watermark across a bounded continuation', () => {
    expect(
      planSyncV2JournalPage({
        afterSequence: parseSyncSequence(0),
        highWatermark: parseSyncSequence(3),
        candidates: [change(1), change(2), change(3)],
        limit: 2,
      }),
    ).toMatchObject({
      kind: 'ready',
      page: {
        highWatermark: 3,
        changes: [{ sequence: 1 }, { sequence: 2 }],
        page: { kind: 'more', afterSequence: 2 },
      },
    });
  });

  it('rejects a gap instead of advancing past a missing change', () => {
    expect(
      planSyncV2JournalPage({
        afterSequence: parseSyncSequence(0),
        highWatermark: parseSyncSequence(3),
        candidates: [change(1), change(3)],
        limit: 3,
      }),
    ).toEqual({ kind: 'rejected' });
    expect(
      planSyncV2JournalPage({
        afterSequence: parseSyncSequence(1),
        highWatermark: parseSyncSequence(3),
        candidates: [],
        limit: 3,
      }),
    ).toEqual({ kind: 'rejected' });
  });
});
