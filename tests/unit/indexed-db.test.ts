import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalId, isUuidV7 } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';
import {
  applySyncResponse,
  clearNotesDatabaseForTests,
  loadCards,
  loadPendingMutations,
  persistCardAndMutation,
} from '@/lib/storage/indexed-db';

afterEach(async () => {
  await clearNotesDatabaseForTests();
});

describe('local persistence', () => {
  it('persists an empty offline card with UUIDv7 and provisional id', async () => {
    const id = createInternalId();
    const card: CardRecord = {
      id,
      displayId: { kind: 'provisional', value: 12 },
      title: '',
      body: [],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: null,
    };
    await persistCardAndMutation(card);
    const [stored] = await loadCards();
    expect(stored).toEqual(card);
    expect(isUuidV7(stored.id)).toBe(true);
    expect(await loadPendingMutations()).toHaveLength(1);
  });

  it('coalesces repeated unsent saves per card without duplicating it', async () => {
    const card: CardRecord = {
      id: createInternalId(),
      displayId: { kind: 'provisional', value: 1 },
      title: '一回目',
      body: [],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: null,
    };
    await persistCardAndMutation(card);
    await persistCardAndMutation({ ...card, title: '二回目', localRevision: 2, updatedAt: 2 });
    expect(await loadCards()).toHaveLength(1);
    expect((await loadCards())[0].title).toBe('二回目');
    expect(await loadPendingMutations()).toHaveLength(1);
  });

  it('rebases an edit saved while a sync request is in flight', async () => {
    const card: CardRecord = {
      id: createInternalId(),
      displayId: { kind: 'official', value: 7 },
      title: '端末の新しい編集',
      body: [{ type: 'text', text: '失わない本文' }],
      createdAt: 1,
      updatedAt: 3,
      localRevision: 3,
      serverRevision: 1,
    };
    await persistCardAndMutation(card);

    const result = await applySyncResponse(
      {
        cards: [
          {
            id: card.id,
            officialDisplayId: 7,
            title: '同期要求時の内容',
            body: [],
            createdAt: 1,
            updatedAt: 2,
            revision: 2,
          },
        ],
        conflicts: [],
        acknowledgedMutationIds: [],
      },
      [],
    );

    expect(result.cards[0].title).toBe('端末の新しい編集');
    expect(result.cards[0].body).toEqual([{ type: 'text', text: '失わない本文' }]);
    expect((await loadPendingMutations())[0].baseServerRevision).toBe(2);
  });
});
