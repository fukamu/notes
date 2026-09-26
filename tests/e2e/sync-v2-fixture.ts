import type { PendingMutation } from '@/lib/domain/types';
import { decodeSyncV2Request } from '@/lib/sync/v2-protocol';

export type SyncV2FixtureCard = {
  readonly id: string;
  readonly officialDisplayId: number;
  readonly title: string;
  readonly body: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'link'; readonly targetCardId: string }
  )[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
};

export type SyncV2FixtureRequest = ReturnType<typeof decodeSyncV2Request>;

export type SyncV2FixtureConflict = {
  readonly id: string;
  readonly cardId: string;
  readonly serverRevision: number;
  readonly localTitle: string;
  readonly localBody: SyncV2FixtureCard['body'];
  readonly serverTitle: string;
  readonly serverBody: SyncV2FixtureCard['body'];
  readonly createdAt: number;
};

export function createSyncV2Fixture(input: {
  readonly cards: readonly SyncV2FixtureCard[];
  readonly conflicts?: readonly SyncV2FixtureConflict[];
}) {
  const cards = new Map(input.cards.map((card) => [card.id, card]));
  const conflicts = new Map(
    (input.conflicts ?? []).map((conflict) => [conflict.id, conflict]),
  );
  let initialPending = true;
  let sequence = 0;
  let nextDisplayId =
    Math.max(0, ...input.cards.map((card) => card.officialDisplayId)) + 1;

  return {
    respond(rawRequest: unknown) {
      const request = decodeSyncV2Request(rawRequest);
      const changes: unknown[] = [];
      if (initialPending) {
        initialPending = false;
        for (const card of cards.values()) {
          sequence += 1;
          changes.push({ kind: 'card-upsert', sequence, card });
        }
        for (const conflict of conflicts.values()) {
          sequence += 1;
          changes.push({ kind: 'conflict-upsert', sequence, conflict });
        }
      }
      const receipts = request.mutations.map((mutation) => {
        const card = applyMutation(mutation);
        cards.set(card.id, card);
        sequence += 1;
        changes.push({ kind: 'card-upsert', sequence, card });
        if (mutation.kind === 'resolve') {
          for (const conflictId of mutation.conflictIds) {
            if (!conflicts.delete(conflictId)) continue;
            sequence += 1;
            changes.push({
              kind: 'conflict-tombstone',
              sequence,
              conflictId,
              cardId: mutation.cardId,
              deletedAt: mutation.updatedAt,
            });
          }
        }
        return {
          mutationId: mutation.mutationId,
          cardId: mutation.cardId,
          appliedRevision: card.revision,
        };
      });
      return {
        request,
        response: {
          version: 'sync/v2',
          highWatermark: sequence,
          changes,
          receipts,
          page: {
            kind: 'complete',
            nextCursor: `sync.v2.fixture.${sequence.toString(36).padStart(24, 'a')}`,
          },
        },
      } as const;
    },
  };

  function applyMutation(mutation: PendingMutation): SyncV2FixtureCard {
    const current = cards.get(mutation.cardId);
    const revision =
      (current?.revision ?? mutation.baseServerRevision ?? 0) + 1;
    const officialDisplayId = current?.officialDisplayId ?? nextDisplayId++;
    return {
      id: mutation.cardId,
      officialDisplayId,
      title: mutation.title,
      body: mutation.body,
      createdAt: current?.createdAt ?? mutation.createdAt,
      updatedAt: mutation.updatedAt,
      revision,
    };
  }
}
