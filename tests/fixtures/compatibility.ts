import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import type { SyncRequest, SyncResponse } from '@/lib/sync/protocol';
import {
  parseCardId,
  parseConflictId,
  parseDeviceId,
  parseMutationId,
} from '@/lib/domain/id';

export const compatibilityIds = {
  cardA: parseCardId('01991f20-61d2-7000-8000-000000000001'),
  cardB: parseCardId('01991f20-61d2-7000-8000-000000000002'),
  conflict: parseConflictId('01991f20-61d2-7000-8000-000000000003'),
  device: parseDeviceId('01991f20-61d2-7000-8000-000000000004'),
  mutation: parseMutationId('01991f20-61d2-7000-8000-000000000005'),
} as const;

export function createCompatibilityFixture(): {
  cards: CardRecord[];
  conflict: ConflictRecord;
  mutation: PendingMutation;
  request: SyncRequest;
  response: SyncResponse;
} {
  const cards: CardRecord[] = [
    {
      id: compatibilityIds.cardA,
      displayId: { kind: 'official', value: 1 },
      title: '固定カードA',
      body: [
        { type: 'text', text: '固定本文から ' },
        { type: 'link', targetCardId: compatibilityIds.cardB },
        { type: 'text', text: ' へつなぐ。' },
      ],
      createdAt: 1_789_000_000_000,
      updatedAt: 1_789_000_000_100,
      localRevision: 2,
      serverRevision: 1,
    },
    {
      id: compatibilityIds.cardB,
      displayId: { kind: 'provisional', value: 2 },
      title: '固定カードB',
      body: [],
      createdAt: 1_789_000_000_200,
      updatedAt: 1_789_000_000_200,
      localRevision: 1,
      serverRevision: null,
    },
  ];

  const mutation: PendingMutation = {
    mutationId: compatibilityIds.mutation,
    cardId: compatibilityIds.cardA,
    kind: 'upsert',
    baseServerRevision: 1,
    title: cards[0]?.title ?? '',
    body: cards[0]?.body ?? [],
    createdAt: cards[0]?.createdAt ?? 0,
    updatedAt: cards[0]?.updatedAt ?? 0,
    conflictIds: [],
  };

  const conflict: ConflictRecord = {
    id: compatibilityIds.conflict,
    cardId: compatibilityIds.cardA,
    serverRevision: 2,
    localTitle: '端末側タイトル',
    localBody: [{ type: 'text', text: '端末側本文' }],
    serverTitle: '同期先タイトル',
    serverBody: [{ type: 'text', text: '同期先本文' }],
    createdAt: 1_789_000_000_300,
  };

  return {
    cards,
    conflict,
    mutation,
    request: {
      deviceId: compatibilityIds.device,
      mutations: [mutation],
    },
    response: {
      cards: [
        {
          id: compatibilityIds.cardA,
          officialDisplayId: 1,
          title: mutation.title,
          body: mutation.body,
          createdAt: mutation.createdAt,
          updatedAt: mutation.updatedAt,
          revision: 2,
        },
        {
          id: compatibilityIds.cardB,
          officialDisplayId: 2,
          title: cards[1]?.title ?? '',
          body: cards[1]?.body ?? [],
          createdAt: cards[1]?.createdAt ?? 0,
          updatedAt: cards[1]?.updatedAt ?? 0,
          revision: 1,
        },
      ],
      conflicts: [conflict],
      acknowledgedMutationIds: [compatibilityIds.mutation],
    },
  };
}
