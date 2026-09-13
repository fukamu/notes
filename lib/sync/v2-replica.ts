import { reconcileProvisionalDisplayIds } from '../domain/display-id';
import type { CardId, ConflictId } from '../domain/id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '../domain/types';
import { assertNever } from '../shared/invariant';
import type { ServerCard } from './protocol';
import type { SyncV2Checkpoint, SyncV2CommitPlan } from './v2-page-application';
import { parseSyncSequence } from './v2-protocol';

export type SyncV2ReplicaStorageOperation =
  | { readonly type: 'delete-card'; readonly cardId: CardId }
  | { readonly type: 'put-card'; readonly card: CardRecord }
  | { readonly type: 'delete-mutation'; readonly cardId: CardId }
  | { readonly type: 'put-mutation'; readonly mutation: PendingMutation }
  | { readonly type: 'delete-conflict'; readonly conflictId: ConflictId }
  | { readonly type: 'put-conflict'; readonly conflict: ConflictRecord };

export type SyncV2ReplicaCommitDecision =
  | {
      readonly kind: 'apply';
      readonly checkpoint: SyncV2Checkpoint;
      readonly cards: readonly CardRecord[];
      readonly conflicts: readonly ConflictRecord[];
      readonly operations: readonly SyncV2ReplicaStorageOperation[];
    }
  | {
      readonly kind: 'already-applied';
      readonly checkpoint: SyncV2Checkpoint;
      readonly cards: readonly CardRecord[];
      readonly conflicts: readonly ConflictRecord[];
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'stale-checkpoint' | 'invalid-receipt';
      readonly checkpoint: SyncV2Checkpoint;
    };

export type SyncV2ReplicaCommitResult =
  | {
      readonly kind: 'applied' | 'already-applied';
      readonly checkpoint: SyncV2Checkpoint;
      readonly cards: readonly CardRecord[];
      readonly conflicts: readonly ConflictRecord[];
    }
  | Extract<SyncV2ReplicaCommitDecision, { readonly kind: 'rejected' }>;

export type SyncV2ReplicaRepository<TScope> = {
  readonly scope: TScope;
  loadCheckpoint: () => Promise<SyncV2Checkpoint>;
  applyCommit: (
    plan: SyncV2CommitPlan,
    sentMutations: readonly PendingMutation[],
  ) => Promise<SyncV2ReplicaCommitResult>;
};

export function initialSyncV2Checkpoint(): SyncV2Checkpoint {
  return { cursor: null, highWatermark: parseSyncSequence(0) };
}

function sameCheckpoint(
  left: SyncV2Checkpoint,
  right: SyncV2Checkpoint,
): boolean {
  return (
    left.cursor === right.cursor && left.highWatermark === right.highWatermark
  );
}

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
      return assertNever(mutation, 'Unsupported Sync v2 mutation rebase');
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

function validReceipts(
  plan: SyncV2CommitPlan,
  sentMutations: readonly PendingMutation[],
): boolean {
  const sentByMutation = new Map(
    sentMutations.map((mutation) => [mutation.mutationId, mutation]),
  );
  const seen = new Set<string>();
  for (const receipt of plan.receipts) {
    const sent = sentByMutation.get(receipt.mutationId);
    if (
      seen.has(receipt.mutationId) ||
      sent === undefined ||
      sent.cardId !== receipt.cardId
    ) {
      return false;
    }
    seen.add(receipt.mutationId);
  }
  return true;
}

function changedOperations<TKey, TValue>(input: {
  readonly before: ReadonlyMap<TKey, TValue>;
  readonly after: ReadonlyMap<TKey, TValue>;
  readonly remove: (id: TKey) => SyncV2ReplicaStorageOperation;
  readonly put: (value: TValue) => SyncV2ReplicaStorageOperation;
}): SyncV2ReplicaStorageOperation[] {
  const operations: SyncV2ReplicaStorageOperation[] = [];
  for (const id of input.before.keys()) {
    if (!input.after.has(id)) operations.push(input.remove(id));
  }
  for (const [id, value] of input.after) {
    if (input.before.get(id) !== value) operations.push(input.put(value));
  }
  return operations;
}

/**
 * Plans the complete local replica transition without touching IndexedDB.
 * The adapter applies every operation plus the checkpoint in one transaction.
 */
export function planSyncV2ReplicaCommit(input: {
  readonly plan: SyncV2CommitPlan;
  readonly currentCheckpoint: SyncV2Checkpoint;
  readonly localCards: readonly CardRecord[];
  readonly currentMutations: readonly PendingMutation[];
  readonly localConflicts: readonly ConflictRecord[];
  readonly sentMutations: readonly PendingMutation[];
}): SyncV2ReplicaCommitDecision {
  if (!validReceipts(input.plan, input.sentMutations)) {
    return {
      kind: 'rejected',
      reason: 'invalid-receipt',
      checkpoint: input.currentCheckpoint,
    };
  }
  if (!sameCheckpoint(input.currentCheckpoint, input.plan.previousCheckpoint)) {
    if (sameCheckpoint(input.currentCheckpoint, input.plan.nextCheckpoint)) {
      return {
        kind: 'already-applied',
        checkpoint: input.currentCheckpoint,
        cards: [...input.localCards],
        conflicts: [...input.localConflicts],
      };
    }
    return {
      kind: 'rejected',
      reason: 'stale-checkpoint',
      checkpoint: input.currentCheckpoint,
    };
  }

  const cardsBefore = new Map(input.localCards.map((card) => [card.id, card]));
  const cards = new Map(cardsBefore);
  const mutationsBefore = new Map(
    input.currentMutations.map((mutation) => [mutation.cardId, mutation]),
  );
  const mutations = new Map(mutationsBefore);
  const conflictsBefore = new Map(
    input.localConflicts.map((conflict) => [conflict.id, conflict]),
  );
  const conflicts = new Map(conflictsBefore);
  const sentByCard = new Map(
    input.sentMutations.map((mutation) => [mutation.cardId, mutation]),
  );
  const receiptsByMutation = new Map(
    input.plan.receipts.map((receipt) => [receipt.mutationId, receipt]),
  );

  for (const receipt of input.plan.receipts) {
    const current = mutations.get(receipt.cardId);
    if (current?.mutationId === receipt.mutationId) {
      mutations.delete(receipt.cardId);
    }
  }

  for (const change of input.plan.changes) {
    switch (change.kind) {
      case 'card-upsert': {
        const cardId = change.card.id;
        const local = cards.get(cardId);
        let pending = mutations.get(cardId);
        const sent = sentByCard.get(cardId);
        const pendingWasNotInThisRequest =
          pending !== undefined && sent === undefined;
        const newerEditWasSaved =
          pending !== undefined &&
          sent !== undefined &&
          pending.mutationId !== sent.mutationId &&
          receiptsByMutation.has(sent.mutationId);
        if (pending && (pendingWasNotInThisRequest || newerEditWasSaved)) {
          pending = rebasePendingMutation(pending, change.card.revision);
          mutations.set(cardId, pending);
        }
        if (local && pending) {
          cards.set(cardId, {
            ...local,
            displayId: {
              kind: 'official',
              value: change.card.officialDisplayId,
            },
            serverRevision: change.card.revision,
          });
        } else {
          cards.set(cardId, cardFromServer(change.card, local));
        }
        break;
      }
      case 'card-tombstone':
        if (!mutations.has(change.cardId)) cards.delete(change.cardId);
        break;
      case 'conflict-upsert':
        conflicts.set(change.conflict.id, change.conflict);
        break;
      case 'conflict-tombstone':
        conflicts.delete(change.conflictId);
        break;
      default:
        assertNever(change, 'Unsupported Sync v2 replica change');
    }
  }

  const reconciledCards = reconcileProvisionalDisplayIds([...cards.values()]);
  const reconciledById = new Map(
    reconciledCards.map((card) => [card.id, card]),
  );
  const mutationOperations = changedOperations({
    before: mutationsBefore,
    after: mutations,
    remove: (cardId) => ({ type: 'delete-mutation', cardId }),
    put: (mutation) => ({ type: 'put-mutation', mutation }),
  });
  const cardOperations = changedOperations({
    before: cardsBefore,
    after: reconciledById,
    remove: (cardId) => ({ type: 'delete-card', cardId }),
    put: (card) => ({ type: 'put-card', card }),
  });
  const conflictOperations: SyncV2ReplicaStorageOperation[] = [];
  for (const conflictId of conflictsBefore.keys()) {
    if (!conflicts.has(conflictId)) {
      conflictOperations.push({ type: 'delete-conflict', conflictId });
    }
  }
  for (const [conflictId, conflict] of conflicts) {
    if (conflictsBefore.get(conflictId) !== conflict) {
      conflictOperations.push({ type: 'put-conflict', conflict });
    }
  }

  return {
    kind: 'apply',
    checkpoint: input.plan.nextCheckpoint,
    cards: reconciledCards,
    conflicts: [...conflicts.values()],
    operations: [
      ...mutationOperations,
      ...cardOperations,
      ...conflictOperations,
    ],
  };
}
