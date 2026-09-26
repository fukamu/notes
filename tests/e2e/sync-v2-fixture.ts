import type { PendingMutation } from '@/lib/domain/types';
import { decodeSyncV2Request, SYNC_V2_LIMITS } from '@/lib/sync/v2-protocol';

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

type SyncV2FixtureChange =
  | {
      readonly kind: 'card-upsert';
      readonly sequence: number;
      readonly card: SyncV2FixtureCard;
    }
  | {
      readonly kind: 'conflict-upsert';
      readonly sequence: number;
      readonly conflict: SyncV2FixtureConflict;
    }
  | {
      readonly kind: 'conflict-tombstone';
      readonly sequence: number;
      readonly conflictId: string;
      readonly cardId: string;
      readonly deletedAt: number;
    };

export function createSyncV2Fixture(input: {
  readonly cards: readonly SyncV2FixtureCard[];
  readonly conflicts?: readonly SyncV2FixtureConflict[];
}) {
  const cards = new Map(input.cards.map((card) => [card.id, card]));
  const conflicts = new Map(
    (input.conflicts ?? []).map((conflict) => [conflict.id, conflict]),
  );
  let sequence = 0;
  let nextDisplayId =
    Math.max(0, ...input.cards.map((card) => card.officialDisplayId)) + 1;
  const changes: SyncV2FixtureChange[] = [];
  const receipts = new Map<
    string,
    {
      readonly mutationId: string;
      readonly cardId: string;
      readonly appliedRevision: number;
    }
  >();
  const cursorPositions = new Map<string, number>();

  for (const card of cards.values()) {
    sequence += 1;
    changes.push({ kind: 'card-upsert', sequence, card });
  }
  for (const conflict of conflicts.values()) {
    sequence += 1;
    changes.push({ kind: 'conflict-upsert', sequence, conflict });
  }

  return {
    respond(rawRequest: unknown) {
      const request = decodeSyncV2Request(rawRequest);
      const responseReceipts = request.mutations.map((mutation) => {
        const prior = receipts.get(mutation.mutationId);
        if (prior !== undefined) return prior;
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
        const receipt = {
          mutationId: mutation.mutationId,
          cardId: mutation.cardId,
          appliedRevision: card.revision,
        };
        receipts.set(mutation.mutationId, receipt);
        return receipt;
      });
      const afterSequence = cursorPosition(request.cursor);
      const highWatermark = sequence;
      const candidates = changes.filter(
        (change) =>
          change.sequence > afterSequence && change.sequence <= highWatermark,
      );
      const pageChanges = candidates.slice(0, SYNC_V2_LIMITS.changesPerPage);
      const nextPosition = pageChanges.at(-1)?.sequence ?? highWatermark;
      const nextCursor = fixtureCursor(nextPosition);
      cursorPositions.set(nextCursor, nextPosition);
      return {
        request,
        response: {
          version: 'sync/v2',
          highWatermark,
          changes: pageChanges,
          receipts: responseReceipts,
          page: {
            kind:
              candidates.length > SYNC_V2_LIMITS.changesPerPage
                ? 'more'
                : 'complete',
            nextCursor,
          },
        },
      } as const;
    },
  };

  function cursorPosition(cursor: string | null): number {
    if (cursor === null) return 0;
    const position = cursorPositions.get(cursor);
    if (position === undefined)
      throw new Error('Unknown Sync v2 fixture cursor');
    return position;
  }

  function fixtureCursor(position: number): string {
    return `sync.v2.fixture.${position.toString(36).padStart(24, '0')}`;
  }

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
