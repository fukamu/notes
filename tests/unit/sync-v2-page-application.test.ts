import { describe, expect, it } from 'vitest';
import {
  beginSyncV2PageCollection,
  planMutationReceiptReplay,
  planSyncV2Page,
  type SyncV2PageCollection,
} from '@/lib/sync/v2-page-application';
import {
  parseSyncSequence,
  parseSyncV2Cursor,
  SYNC_V2_VERSION,
} from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';

const pageCursor = parseSyncV2Cursor(
  'sync.v2.page.ccccccccccccccccccccccccccccccccccccccccccc',
);
const committedCursor = parseSyncV2Cursor(
  'sync.v2.page.ddddddddddddddddddddddddddddddddddddddddddd',
);

function initialState(): SyncV2PageCollection {
  const fixture = createCompatibilityFixture();
  return beginSyncV2PageCollection({
    checkpoint: { cursor: null, highWatermark: parseSyncSequence(0) },
    sentMutations: [fixture.mutation],
  });
}

function firstPage() {
  const fixture = createCompatibilityFixture();
  const [card] = fixture.response.cards;
  if (card === undefined) throw new Error('missing compatibility server card');
  return {
    version: SYNC_V2_VERSION,
    highWatermark: 4,
    changes: [
      { kind: 'card-upsert', sequence: 1, card },
      {
        kind: 'conflict-upsert',
        sequence: 2,
        conflict: fixture.conflict,
      },
    ],
    receipts: [
      {
        mutationId: compatibilityIds.mutation,
        cardId: compatibilityIds.cardA,
        appliedRevision: 2,
      },
    ],
    page: { kind: 'more', nextCursor: pageCursor },
  };
}

function finalPage() {
  return {
    version: SYNC_V2_VERSION,
    highWatermark: 4,
    changes: [
      {
        kind: 'card-tombstone',
        sequence: 3,
        cardId: compatibilityIds.cardA,
        revision: 3,
        deletedAt: 1_789_000_000_400,
      },
      {
        kind: 'conflict-tombstone',
        sequence: 4,
        conflictId: compatibilityIds.conflict,
        cardId: compatibilityIds.cardA,
        deletedAt: 1_789_000_000_401,
      },
    ],
    // An identical receipt on a later page is an idempotent replay, not a second ack.
    receipts: [
      {
        mutationId: compatibilityIds.mutation,
        cardId: compatibilityIds.cardA,
        appliedRevision: 2,
      },
    ],
    page: { kind: 'complete', nextCursor: committedCursor },
  };
}

function collectFirstPage() {
  const decision = planSyncV2Page({
    state: initialState(),
    requestCursor: null,
    response: firstPage(),
  });
  if (decision.kind !== 'continue') {
    throw new Error('first page fixture did not continue');
  }
  return decision.state;
}

describe('sync v2 page application state machine', () => {
  it('preserves update/delete order across pages and advances only at commit', () => {
    const collecting = collectFirstPage();
    const decision = planSyncV2Page({
      state: collecting,
      requestCursor: pageCursor,
      response: finalPage(),
    });

    expect(decision.kind).toBe('ready-to-commit');
    if (decision.kind !== 'ready-to-commit') return;
    expect(decision.state).toBe(collecting);
    expect(decision.plan.previousCheckpoint).toEqual({
      cursor: null,
      highWatermark: 0,
    });
    expect(decision.plan.nextCheckpoint).toEqual({
      cursor: committedCursor,
      highWatermark: 4,
    });
    expect(decision.plan.changes.map((change) => change.kind)).toEqual([
      'card-upsert',
      'conflict-upsert',
      'card-tombstone',
      'conflict-tombstone',
    ]);
    expect(decision.plan.receipts).toHaveLength(1);
  });

  it('returns the unchanged state for malformed pages and mismatched cursors', () => {
    const state = initialState();
    const malformed = planSyncV2Page({
      state,
      requestCursor: null,
      response: { ...firstPage(), highWatermark: 'private content' },
    });
    expect(malformed).toMatchObject({
      kind: 'rejected',
      reason: 'malformed-page',
    });
    expect(malformed.state).toBe(state);

    const mismatched = planSyncV2Page({
      state,
      requestCursor: pageCursor,
      response: firstPage(),
    });
    expect(mismatched).toMatchObject({
      kind: 'rejected',
      reason: 'cursor-mismatch',
    });
    expect(mismatched.state).toBe(state);
  });

  it('rejects reordered pages, a changed snapshot, and a non-advancing cursor', () => {
    const state = collectFirstPage();
    for (const [response, reason] of [
      [
        {
          ...finalPage(),
          changes: [{ ...finalPage().changes[0], sequence: 2 }],
        },
        'sequence-reordered',
      ],
      [{ ...finalPage(), highWatermark: 5 }, 'high-watermark-changed'],
      [
        {
          ...finalPage(),
          changes: [],
          page: { kind: 'more', nextCursor: pageCursor },
        },
        'non-advancing-cursor',
      ],
    ] as const) {
      const decision = planSyncV2Page({
        state,
        requestCursor: pageCursor,
        response,
      });
      expect(decision).toMatchObject({ kind: 'rejected', reason });
      expect(decision.state).toBe(state);
    }
  });

  it('produces the same terminal plan when a response is lost before commit', () => {
    const state = collectFirstPage();
    const firstAttempt = planSyncV2Page({
      state,
      requestCursor: pageCursor,
      response: finalPage(),
    });
    const retry = planSyncV2Page({
      state,
      requestCursor: pageCursor,
      response: finalPage(),
    });
    expect(firstAttempt).toEqual(retry);
    expect(firstAttempt.state).toBe(state);
  });

  it('replays a persisted mutation receipt without applying the mutation again', () => {
    const fixture = createCompatibilityFixture();
    const receipt = {
      mutationId: compatibilityIds.mutation,
      cardId: compatibilityIds.cardA,
      appliedRevision: 2,
    } as const;
    expect(planMutationReceiptReplay(fixture.mutation, undefined)).toEqual({
      kind: 'apply',
    });
    expect(planMutationReceiptReplay(fixture.mutation, receipt)).toEqual({
      kind: 'replay',
      receipt,
    });
    expect(
      planMutationReceiptReplay(
        { ...fixture.mutation, cardId: compatibilityIds.cardB },
        receipt,
      ),
    ).toEqual({ kind: 'rejected', reason: 'mutation-card-mismatch' });
  });
});
