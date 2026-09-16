import { describe, expect, it } from 'vitest';
import { parseContentRevision } from '@/server/vault-content/records';
import {
  canonicalizeSyncV2Mutation,
  hydrateSyncV2JournalChange,
  planSyncV2Mutation,
  syncV2CursorWindow,
} from '@/server/sync-v2/core';
import {
  decodeSyncV2CursorClaims,
  SYNC_V2_CURSOR_VERSION,
} from '@/lib/sync/v2-cursor';
import { parseSyncSequence } from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { vaultContentContext } from '@/tests/fixtures/vault-content';

const current = {
  cardId: compatibilityIds.cardA,
  officialDisplayId: 7,
  revision: parseContentRevision(2),
  updatedAt: 2_000,
} as const;

const currentContent = {
  title: 'server title',
  body: [{ type: 'text', text: 'server body' }] as const,
  createdAt: 1_000,
  updatedAt: 2_000,
};

describe('Sync v2 server pure decisions', () => {
  it('plans create/update while preserving server-owned creation time', () => {
    const mutation = upsertMutation();
    expect(
      planSyncV2Mutation({
        mutation: { ...mutation, baseServerRevision: null },
        current: undefined,
        currentContent: undefined,
      }),
    ).toMatchObject({
      kind: 'write-card',
      expectedRevision: null,
      nextRevision: 1,
    });

    expect(
      planSyncV2Mutation({
        mutation: {
          ...mutation,
          baseServerRevision: 2,
          updatedAt: 2_100,
        },
        current,
        currentContent,
      }),
    ).toMatchObject({
      kind: 'write-card',
      expectedRevision: 2,
      nextRevision: 3,
      content: { createdAt: 1_000, updatedAt: 2_100 },
    });
  });

  it('requires exact current content and preserves a real concurrent edit', () => {
    const mutation = {
      ...upsertMutation(),
      baseServerRevision: 1,
      title: 'local title',
      updatedAt: 2_100,
    };
    expect(
      planSyncV2Mutation({
        mutation,
        current,
        currentContent: undefined,
      }),
    ).toEqual({ kind: 'requires-current-content', revision: 2 });
    expect(planSyncV2Mutation({ mutation, current, currentContent })).toEqual({
      kind: 'write-conflict',
      conflictId: compatibilityIds.mutation,
      serverRevision: 2,
      content: {
        localTitle: 'local title',
        localBody: mutation.body,
        serverTitle: 'server title',
        serverBody: currentContent.body,
        createdAt: 2_100,
      },
    });
  });

  it('keeps the legacy identical-content rebase and rejects stale resolve', () => {
    const mutation = upsertMutation();
    expect(
      planSyncV2Mutation({
        mutation: {
          ...mutation,
          baseServerRevision: 1,
          title: currentContent.title,
          body: [...currentContent.body],
          updatedAt: 2_100,
        },
        current,
        currentContent,
      }),
    ).toMatchObject({ kind: 'write-card', expectedRevision: 2 });
    expect(
      planSyncV2Mutation({
        mutation: {
          ...mutation,
          kind: 'resolve',
          conflictIds: [compatibilityIds.conflict],
          baseServerRevision: 1,
        },
        current,
        currentContent,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-revision' });
  });

  it('canonicalizes every mutation field and renews only terminal snapshots', () => {
    const mutation = upsertMutation();
    expect(canonicalizeSyncV2Mutation(mutation)).not.toBe(
      canonicalizeSyncV2Mutation({ ...mutation, title: `${mutation.title}!` }),
    );
    const context = vaultContentContext('a');
    const continuation = decodeSyncV2CursorClaims({
      version: SYNC_V2_CURSOR_VERSION,
      vaultId: context.vaultId,
      deviceId: compatibilityIds.device,
      afterSequence: 2,
      highWatermark: 4,
    });
    expect(syncV2CursorWindow(continuation)).toEqual({
      afterSequence: 2,
      highWatermark: 4,
    });
    expect(
      syncV2CursorWindow({
        ...continuation,
        afterSequence: parseSyncSequence(4),
      }),
    ).toEqual({ afterSequence: 4, highWatermark: null });
  });

  it('hydrates exact revision metadata and rejects payload timeline swaps', () => {
    const change = {
      kind: 'card-upsert' as const,
      sequence: parseSyncSequence(3),
      cardId: current.cardId,
      officialDisplayId: current.officialDisplayId,
      revision: current.revision,
      occurredAt: current.updatedAt,
    };
    expect(
      hydrateSyncV2JournalChange(change, {
        kind: 'card',
        content: currentContent,
      }),
    ).toMatchObject({
      kind: 'hydrated',
      change: { card: { revision: 2, officialDisplayId: 7 } },
    });
    expect(
      hydrateSyncV2JournalChange(change, {
        kind: 'card',
        content: { ...currentContent, updatedAt: 1_999 },
      }),
    ).toEqual({ kind: 'rejected' });
  });
});

function upsertMutation() {
  const mutation = createCompatibilityFixture().mutation;
  if (mutation.kind !== 'upsert') throw new Error('expected upsert fixture');
  return mutation;
}
