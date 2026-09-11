import { reconcileProvisionalDisplayIds } from '@/lib/domain/display-id';
import type { CardId } from '@/lib/domain/id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import type { ServerCard, SyncResponse } from '@/lib/sync/protocol';
import { assertNever } from '@/lib/shared/invariant';

export type SyncStorageOperation =
  | { type: 'delete-mutation'; cardId: CardId }
  | { type: 'put-mutation'; mutation: PendingMutation }
  | { type: 'put-card'; card: CardRecord }
  | { type: 'clear-conflicts' }
  | { type: 'put-conflict'; conflict: ConflictRecord };

export type SyncApplicationPlan = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  operations: SyncStorageOperation[];
};

function rebasePendingMutation(
  mutation: PendingMutation,
  serverRevision: number,
): PendingMutation {
  switch (mutation.kind) {
    case 'upsert':
      return { ...mutation, baseServerRevision: serverRevision };
    case 'resolve':
      return { ...mutation, baseServerRevision: serverRevision };
    default:
      return assertNever(mutation, 'Unsupported mutation rebase');
  }
}

function cardFromServer(
  serverCard: ServerCard,
  local: CardRecord | undefined,
): CardRecord {
  return {
    id: serverCard.id,
    displayId: { kind: 'official', value: serverCard.officialDisplayId },
    title: serverCard.title,
    body: serverCard.body,
    createdAt: serverCard.createdAt,
    updatedAt: serverCard.updatedAt,
    localRevision: local?.localRevision ?? serverCard.revision,
    serverRevision: serverCard.revision,
  };
}

/**
 * Decides the complete IndexedDB update without performing I/O. The adapter
 * executes `operations` in order inside the transaction that supplied the
 * local snapshots.
 */
export function planSyncResponseApplication(input: {
  response: SyncResponse;
  localCards: readonly CardRecord[];
  currentMutations: readonly PendingMutation[];
  sentMutations: readonly PendingMutation[];
}): SyncApplicationPlan {
  const acknowledged = new Set(input.response.acknowledgedMutationIds);
  const sentByCard = new Map(
    input.sentMutations.map((mutation) => [mutation.cardId, mutation]),
  );
  const pendingByCard = new Map(
    input.currentMutations.map((mutation) => [mutation.cardId, mutation]),
  );
  const operations: SyncStorageOperation[] = [];

  for (const mutation of input.currentMutations) {
    if (!acknowledged.has(mutation.mutationId)) continue;
    operations.push({ type: 'delete-mutation', cardId: mutation.cardId });
    pendingByCard.delete(mutation.cardId);
  }

  const merged = new Map(input.localCards.map((card) => [card.id, card]));
  for (const serverCard of input.response.cards) {
    const local = merged.get(serverCard.id);
    const pending = pendingByCard.get(serverCard.id);
    const sent = sentByCard.get(serverCard.id);
    const pendingWasNotInThisRequest =
      pending !== undefined && sent === undefined;
    const newerEditWasSaved =
      pending !== undefined &&
      sent !== undefined &&
      pending.mutationId !== sent.mutationId &&
      acknowledged.has(sent.mutationId);

    if (pending && (pendingWasNotInThisRequest || newerEditWasSaved)) {
      const rebased = rebasePendingMutation(pending, serverCard.revision);
      operations.push({ type: 'put-mutation', mutation: rebased });
      pendingByCard.set(serverCard.id, rebased);
    }

    if (local && pendingByCard.has(serverCard.id)) {
      merged.set(serverCard.id, {
        ...local,
        displayId: { kind: 'official', value: serverCard.officialDisplayId },
        serverRevision: serverCard.revision,
      });
      continue;
    }

    merged.set(serverCard.id, cardFromServer(serverCard, local));
  }

  const cards = reconcileProvisionalDisplayIds([...merged.values()]);
  for (const card of cards) operations.push({ type: 'put-card', card });

  const conflicts = [...input.response.conflicts];
  operations.push({ type: 'clear-conflicts' });
  for (const conflict of conflicts) {
    operations.push({ type: 'put-conflict', conflict });
  }

  return { cards, conflicts, operations };
}

/**
 * Combines the transaction result with edits made after the request snapshot.
 * Newer local content wins while server identity/revision progress is retained.
 */
export function reconcileVisibleCardsAfterSync(input: {
  currentCards: readonly CardRecord[];
  revisionsAtRequest: ReadonlyMap<CardId, number>;
  mergedCards: readonly CardRecord[];
}): CardRecord[] {
  const remainingLocal = new Map(
    input.currentCards.map((card) => [card.id, card]),
  );
  const visibleCards = input.mergedCards.map((mergedCard) => {
    const latestLocal = remainingLocal.get(mergedCard.id);
    remainingLocal.delete(mergedCard.id);
    const revisionAtRequest = input.revisionsAtRequest.get(mergedCard.id);
    if (
      !latestLocal ||
      revisionAtRequest === undefined ||
      latestLocal.localRevision <= revisionAtRequest
    ) {
      return mergedCard;
    }
    return {
      ...latestLocal,
      displayId: mergedCard.displayId,
      serverRevision: mergedCard.serverRevision,
    };
  });

  visibleCards.push(...remainingLocal.values());
  return visibleCards;
}
