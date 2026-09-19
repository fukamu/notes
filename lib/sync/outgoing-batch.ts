import type { PendingMutationMode } from '@/lib/domain/card-transitions';
import { createPendingMutation } from '@/lib/domain/card-transitions';
import type { DeviceId, MutationId } from '@/lib/domain/id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import { rebasePendingMutationAfterSync } from '@/lib/sync/pending-mutation';
import type { ServerCard } from '@/lib/sync/protocol';
import type { SyncV2MutationReceipt } from '@/lib/sync/v2-protocol';

declare const outgoingBatchIdBrand: unique symbol;

export type OutgoingBatchId = string & {
  readonly [outgoingBatchIdBrand]: 'OutgoingBatchId';
};

export type MutationDraftOrigin = {
  readonly version: 1;
  readonly baseServerRevision: number | null;
  readonly predecessorMutationId: MutationId | null;
};

export type LocalMutationDraft = {
  readonly mutation: PendingMutation;
  readonly origin: MutationDraftOrigin;
};

export type OutgoingBatch = {
  readonly version: 1;
  readonly batchId: OutgoingBatchId;
  readonly deviceId: DeviceId;
  readonly mutations: readonly PendingMutation[];
};

export type LocalMutationDraftResult =
  | { readonly ok: true; readonly draft: LocalMutationDraft }
  | {
      readonly ok: false;
      readonly reason:
        | 'conflict-limit-exceeded'
        | 'existing-mutation-card-mismatch'
        | 'missing-server-revision';
    };

export function outgoingBatchIdFromMutation(
  mutationId: MutationId,
): OutgoingBatchId {
  return `outgoing.v1.${mutationId}` as OutgoingBatchId;
}

export function legacyMutationDraft(
  mutation: PendingMutation,
): LocalMutationDraft {
  return {
    mutation,
    origin: {
      version: 1,
      baseServerRevision: mutation.baseServerRevision,
      predecessorMutationId: null,
    },
  };
}

export function createLocalMutationDraft(input: {
  readonly card: CardRecord;
  readonly mutationId: MutationId;
  readonly mode: PendingMutationMode;
  readonly existingDraft: LocalMutationDraft | undefined;
  readonly outgoingMutation: PendingMutation | undefined;
}): LocalMutationDraftResult {
  const inheritedOrigin =
    input.mode.kind === 'upsert' ? input.existingDraft?.origin : undefined;
  const predecessor =
    inheritedOrigin === undefined && input.mode.kind === 'upsert'
      ? input.outgoingMutation
      : undefined;
  const origin: MutationDraftOrigin =
    input.mode.kind === 'resolve'
      ? {
          version: 1,
          baseServerRevision: input.card.serverRevision,
          predecessorMutationId: null,
        }
      : (inheritedOrigin ??
        (predecessor === undefined
          ? {
              version: 1,
              baseServerRevision: input.card.serverRevision,
              predecessorMutationId: null,
            }
          : {
              version: 1,
              baseServerRevision: predecessor.baseServerRevision,
              predecessorMutationId: predecessor.mutationId,
            }));
  const result = createPendingMutation(
    { ...input.card, serverRevision: origin.baseServerRevision },
    input.mutationId,
    input.mode,
    input.existingDraft?.mutation,
  );
  return result.ok
    ? { ok: true, draft: { mutation: result.mutation, origin } }
    : result;
}

export function selectEligibleMutationDrafts(input: {
  readonly drafts: readonly LocalMutationDraft[];
  readonly conflicts: readonly ConflictRecord[];
  readonly limit: number;
}): LocalMutationDraft[] {
  const conflictedCards = new Set(
    input.conflicts.map((conflict) => conflict.cardId),
  );
  return input.drafts
    .filter(
      (draft) =>
        draft.mutation.kind === 'resolve' ||
        !conflictedCards.has(draft.mutation.cardId),
    )
    .slice(0, input.limit);
}

function bodiesEqual(
  left: PendingMutation['body'],
  right: ServerCard['body'],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    if (other === undefined || segment.type !== other.type) return false;
    switch (segment.type) {
      case 'text':
        return other.type === 'text' && segment.text === other.text;
      case 'link':
        return (
          other.type === 'link' && segment.targetCardId === other.targetCardId
        );
    }
  });
}

export function rebaseCausalSuccessor(input: {
  readonly draft: LocalMutationDraft;
  readonly acknowledgedMutation: PendingMutation;
  readonly receipt: SyncV2MutationReceipt;
  readonly appliedCard: ServerCard | undefined;
  readonly conflicts: readonly ConflictRecord[];
}): LocalMutationDraft {
  if (
    input.draft.origin.predecessorMutationId !==
      input.acknowledgedMutation.mutationId ||
    input.receipt.mutationId !== input.acknowledgedMutation.mutationId ||
    input.receipt.cardId !== input.acknowledgedMutation.cardId ||
    input.appliedCard === undefined ||
    input.appliedCard.id !== input.acknowledgedMutation.cardId ||
    input.appliedCard.revision !== input.receipt.appliedRevision ||
    input.appliedCard.title !== input.acknowledgedMutation.title ||
    input.appliedCard.createdAt !== input.acknowledgedMutation.createdAt ||
    input.appliedCard.updatedAt !== input.acknowledgedMutation.updatedAt ||
    !bodiesEqual(input.acknowledgedMutation.body, input.appliedCard.body) ||
    input.conflicts.some(
      (conflict) => conflict.cardId === input.acknowledgedMutation.cardId,
    )
  ) {
    return input.draft;
  }
  return {
    mutation: rebasePendingMutationAfterSync({
      mutation: input.draft.mutation,
      serverRevision: input.receipt.appliedRevision,
      acknowledgedMutation: input.acknowledgedMutation,
    }),
    origin: {
      version: 1,
      baseServerRevision: input.receipt.appliedRevision,
      predecessorMutationId: null,
    },
  };
}
