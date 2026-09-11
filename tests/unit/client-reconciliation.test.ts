import { describe, expect, it } from 'vitest';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import {
  planSyncResponseApplication,
  reconcileVisibleCardsAfterSync,
} from '@/lib/sync/client-reconciliation';
import type { ServerCard, SyncResponse } from '@/lib/sync/protocol';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';

function card(label: string, overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: 1 },
    title: `local ${label}`,
    body: [],
    createdAt: 10,
    updatedAt: 20,
    localRevision: 2,
    serverRevision: 1,
    ...overrides,
  };
}

function serverCard(
  localCard: CardRecord,
  overrides: Partial<ServerCard> = {},
): ServerCard {
  return {
    id: localCard.id,
    officialDisplayId: 1,
    title: `server ${localCard.title}`,
    body: [],
    createdAt: localCard.createdAt,
    updatedAt: localCard.updatedAt + 1,
    revision: 2,
    ...overrides,
  };
}

function mutation(
  label: string,
  localCard: CardRecord,
  overrides: Partial<Extract<PendingMutation, { kind: 'upsert' }>> = {},
): Extract<PendingMutation, { kind: 'upsert' }> {
  return {
    mutationId: fixtureMutationId(label),
    cardId: localCard.id,
    kind: 'upsert',
    baseServerRevision: localCard.serverRevision,
    title: localCard.title,
    body: localCard.body,
    createdAt: localCard.createdAt,
    updatedAt: localCard.updatedAt,
    conflictIds: [],
    ...overrides,
  };
}

describe('sync response application plan', () => {
  it('acknowledges the sent mutation and replaces its card with server data', () => {
    const localCard = card('acknowledged');
    const sent = mutation('acknowledged', localCard);
    const remote = serverCard(localCard, {
      officialDisplayId: 8,
      title: 'accepted server title',
      revision: 3,
    });
    const input = {
      response: {
        cards: [remote],
        conflicts: [],
        acknowledgedMutationIds: [sent.mutationId],
      },
      localCards: [localCard],
      currentMutations: [sent],
      sentMutations: [sent],
    } satisfies {
      response: SyncResponse;
      localCards: CardRecord[];
      currentMutations: PendingMutation[];
      sentMutations: PendingMutation[];
    };
    const before = structuredClone(input);

    const plan = planSyncResponseApplication(input);

    expect(plan.cards).toEqual([
      {
        id: localCard.id,
        displayId: { kind: 'official', value: 8 },
        title: 'accepted server title',
        body: remote.body,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        localRevision: localCard.localRevision,
        serverRevision: 3,
      },
    ]);
    expect(plan.operations).toEqual([
      { type: 'delete-mutation', cardId: localCard.id },
      { type: 'put-card', card: plan.cards[0] },
      { type: 'clear-conflicts' },
    ]);
    expect(input).toEqual(before);
  });

  it('rebases a newer edit saved during the request and retains local content', () => {
    const localCard = card('newer-edit', {
      displayId: { kind: 'provisional', value: 2 },
      title: 'new local title',
      body: [{ type: 'text', text: 'new local body' }],
      localRevision: 4,
    });
    const sent = mutation('sent-edit', localCard, {
      title: 'older sent title',
      updatedAt: 19,
    });
    const current = mutation('newer-edit', localCard);
    const response: SyncResponse = {
      cards: [
        serverCard(localCard, {
          officialDisplayId: 12,
          title: 'accepted older title',
          revision: 7,
        }),
      ],
      conflicts: [],
      acknowledgedMutationIds: [sent.mutationId],
    };

    const plan = planSyncResponseApplication({
      response,
      localCards: [localCard],
      currentMutations: [current],
      sentMutations: [sent],
    });

    const rebased = { ...current, baseServerRevision: 7 };
    expect(plan.cards).toEqual([
      {
        ...localCard,
        displayId: { kind: 'official', value: 12 },
        serverRevision: 7,
      },
    ]);
    expect(plan.operations).toEqual([
      { type: 'put-mutation', mutation: rebased },
      { type: 'put-card', card: plan.cards[0] },
      { type: 'clear-conflicts' },
    ]);
  });

  it('rebases an unsent resolve mutation and plans conflict replacement in order', () => {
    const localCard = card('resolve', { serverRevision: 5 });
    const current: PendingMutation = {
      ...mutation('resolve', localCard),
      kind: 'resolve',
      baseServerRevision: 5,
      conflictIds: [fixtureConflictId('resolve')],
    };
    const conflict: ConflictRecord = {
      id: fixtureConflictId('replacement'),
      cardId: localCard.id,
      serverRevision: 6,
      localTitle: 'local',
      localBody: [],
      serverTitle: 'server',
      serverBody: [],
      createdAt: 30,
    };
    const response: SyncResponse = {
      cards: [serverCard(localCard, { revision: 6 })],
      conflicts: [conflict],
      acknowledgedMutationIds: [],
    };

    const plan = planSyncResponseApplication({
      response,
      localCards: [localCard],
      currentMutations: [current],
      sentMutations: [],
    });

    expect(plan.operations).toEqual([
      {
        type: 'put-mutation',
        mutation: { ...current, baseServerRevision: 6 },
      },
      { type: 'put-card', card: plan.cards[0] },
      { type: 'clear-conflicts' },
      { type: 'put-conflict', conflict },
    ]);
    expect(plan.conflicts).toEqual([conflict]);
  });
});

describe('visible card reconciliation after sync', () => {
  it('retains edits newer than the request while adopting server identity progress', () => {
    const editedDuringRequest = card('edited-during-request', {
      displayId: { kind: 'provisional', value: 3 },
      title: 'latest local title',
      body: [{ type: 'text', text: 'latest local body' }],
      localRevision: 4,
      serverRevision: 1,
    });
    const unchanged = card('unchanged', { localRevision: 2 });
    const addedDuringRequest = card('added-during-request', {
      displayId: { kind: 'provisional', value: 9 },
      localRevision: 1,
      serverRevision: null,
    });
    const mergedEdited = card('edited-during-request', {
      displayId: { kind: 'official', value: 11 },
      title: 'server title',
      localRevision: 3,
      serverRevision: 2,
    });
    const mergedUnchanged = card('unchanged', {
      title: 'server replacement',
      localRevision: 2,
      serverRevision: 2,
    });
    const currentCards = [editedDuringRequest, unchanged, addedDuringRequest];
    const mergedCards = [mergedEdited, mergedUnchanged];
    const revisionsAtRequest = new Map([
      [editedDuringRequest.id, 3],
      [unchanged.id, 2],
    ]);
    const cardsBefore = structuredClone(currentCards);
    const mergedBefore = structuredClone(mergedCards);
    const revisionsBefore = [...revisionsAtRequest];

    const visible = reconcileVisibleCardsAfterSync({
      currentCards,
      revisionsAtRequest,
      mergedCards,
    });

    expect(visible).toEqual([
      {
        ...editedDuringRequest,
        displayId: mergedEdited.displayId,
        serverRevision: mergedEdited.serverRevision,
      },
      mergedUnchanged,
      addedDuringRequest,
    ]);
    expect(currentCards).toEqual(cardsBefore);
    expect(mergedCards).toEqual(mergedBefore);
    expect([...revisionsAtRequest]).toEqual(revisionsBefore);
  });
});
