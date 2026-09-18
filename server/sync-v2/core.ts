import { parseConflictId } from '../../lib/domain/id';
import type { BodySegment, PendingMutation } from '../../lib/domain/types';
import { assertNever } from '../../lib/shared/invariant';
import type {
  SyncSequence,
  SyncV2Change,
  SyncV2MutationReceipt,
} from '../../lib/sync/v2-protocol';
import type { VaultPartitionRoute } from '../vault-content/records';
import type {
  SyncV2JournalChange,
  SyncV2JournalReceipt,
} from '../vault-content/sync-v2-public';
import type {
  SyncV2CursorWindow,
  SyncV2MutationPlan,
  SyncV2MutationPlanningInput,
  SyncV2StoredCard,
  SyncV2StoredConflict,
} from './public';

export function canonicalizeSyncV2Mutation(mutation: PendingMutation): string {
  return JSON.stringify([
    'fukamu-sync-v2-mutation/v1',
    mutation.kind,
    mutation.mutationId,
    mutation.cardId,
    mutation.baseServerRevision,
    mutation.title,
    canonicalBody(mutation.body),
    mutation.createdAt,
    mutation.updatedAt,
    mutation.conflictIds,
  ]);
}

export function planSyncV2Mutation(
  input: SyncV2MutationPlanningInput,
): SyncV2MutationPlan {
  const { mutation, current, currentContent } = input;
  if (current === undefined) {
    if (mutation.kind === 'resolve' || mutation.baseServerRevision !== null) {
      return { kind: 'rejected', reason: 'missing-card' };
    }
    return {
      kind: 'write-card',
      expectedRevision: null,
      nextRevision: 1,
      content: {
        title: mutation.title,
        body: mutation.body,
        createdAt: mutation.createdAt,
        updatedAt: mutation.updatedAt,
      },
    };
  }
  if (currentContent === undefined) {
    return { kind: 'requires-current-content', revision: current.revision };
  }
  if (currentContent.updatedAt !== current.updatedAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  if (mutation.kind === 'resolve') {
    if (mutation.baseServerRevision !== current.revision) {
      return { kind: 'rejected', reason: 'stale-revision' };
    }
    return planCardWrite(mutation, current, currentContent);
  }
  if (
    mutation.baseServerRevision === current.revision ||
    sameEditableContent(mutation, currentContent)
  ) {
    return planCardWrite(mutation, current, currentContent);
  }
  return {
    kind: 'write-conflict',
    conflictId: parseConflictId(mutation.mutationId),
    serverRevision: current.revision,
    content: {
      localTitle: mutation.title,
      localBody: mutation.body,
      serverTitle: currentContent.title,
      serverBody: currentContent.body,
      createdAt: mutation.updatedAt,
    },
  };
}

function planCardWrite(
  mutation: PendingMutation,
  current: NonNullable<SyncV2MutationPlanningInput['current']>,
  currentContent: SyncV2StoredCard,
): SyncV2MutationPlan {
  if (mutation.updatedAt < current.updatedAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  return {
    kind: 'write-card',
    expectedRevision: current.revision,
    nextRevision: current.revision + 1,
    content: {
      title: mutation.title,
      body: mutation.body,
      createdAt: currentContent.createdAt,
      updatedAt: mutation.updatedAt,
    },
  };
}

function sameEditableContent(
  mutation: PendingMutation,
  current: SyncV2StoredCard,
): boolean {
  return (
    mutation.title === current.title && sameBody(mutation.body, current.body)
  );
}

function sameBody(
  left: readonly BodySegment[],
  right: readonly BodySegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const candidate = right[index];
      if (candidate === undefined || candidate.type !== segment.type) {
        return false;
      }
      return segment.type === 'text'
        ? candidate.type === 'text' && candidate.text === segment.text
        : candidate.type === 'link' &&
            candidate.targetCardId === segment.targetCardId;
    })
  );
}

type CanonicalBodySegment =
  | readonly ['text', string]
  | readonly ['link', string];

function canonicalBody(
  body: readonly BodySegment[],
): readonly CanonicalBodySegment[] {
  return body.map((segment) => {
    switch (segment.type) {
      case 'text':
        return ['text', segment.text];
      case 'link':
        return ['link', segment.targetCardId];
      default:
        return assertNever(segment, 'Unsupported Sync v2 body segment');
    }
  });
}

export function syncV2CursorWindow(claims: {
  readonly afterSequence: SyncSequence;
  readonly highWatermark: SyncSequence;
}): SyncV2CursorWindow {
  return {
    afterSequence: claims.afterSequence,
    highWatermark:
      claims.afterSequence === claims.highWatermark
        ? null
        : claims.highWatermark,
  };
}

export function sameVaultPartitionRoute(
  left: VaultPartitionRoute,
  right: VaultPartitionRoute,
): boolean {
  return (
    left.partitionId === right.partitionId &&
    left.routingRevision === right.routingRevision
  );
}

export function toSyncV2MutationReceipt(
  receipt: SyncV2JournalReceipt,
): SyncV2MutationReceipt {
  return {
    mutationId: receipt.mutationId,
    cardId: receipt.cardId,
    appliedRevision: receipt.appliedRevision,
  };
}

export type SyncV2HydrationInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'card'; readonly content: SyncV2StoredCard }
  | { readonly kind: 'conflict'; readonly content: SyncV2StoredConflict };

export type SyncV2HydrationPlan =
  | { readonly kind: 'hydrated'; readonly change: SyncV2Change }
  | { readonly kind: 'rejected' };

export function hydrateSyncV2JournalChange(
  change: SyncV2JournalChange,
  input: SyncV2HydrationInput,
): SyncV2HydrationPlan {
  switch (change.kind) {
    case 'card-upsert':
      if (
        input.kind !== 'card' ||
        input.content.updatedAt !== change.occurredAt
      ) {
        return { kind: 'rejected' };
      }
      return {
        kind: 'hydrated',
        change: {
          kind: change.kind,
          sequence: change.sequence,
          card: {
            id: change.cardId,
            officialDisplayId: change.officialDisplayId,
            title: input.content.title,
            body: [...input.content.body],
            createdAt: input.content.createdAt,
            updatedAt: input.content.updatedAt,
            revision: change.revision,
          },
        },
      };
    case 'conflict-upsert':
      if (
        input.kind !== 'conflict' ||
        input.content.createdAt !== change.occurredAt
      ) {
        return { kind: 'rejected' };
      }
      return {
        kind: 'hydrated',
        change: {
          kind: change.kind,
          sequence: change.sequence,
          conflict: {
            id: change.conflictId,
            cardId: change.cardId,
            serverRevision: change.serverRevision,
            localTitle: input.content.localTitle,
            localBody: [...input.content.localBody],
            serverTitle: input.content.serverTitle,
            serverBody: [...input.content.serverBody],
            createdAt: input.content.createdAt,
          },
        },
      };
    case 'card-tombstone':
      if (input.kind !== 'none') return { kind: 'rejected' };
      return {
        kind: 'hydrated',
        change: {
          kind: change.kind,
          sequence: change.sequence,
          cardId: change.cardId,
          revision: change.revision,
          deletedAt: change.deletedAt,
        },
      };
    case 'conflict-tombstone':
      if (input.kind !== 'none') return { kind: 'rejected' };
      return {
        kind: 'hydrated',
        change: {
          kind: change.kind,
          sequence: change.sequence,
          conflictId: change.conflictId,
          cardId: change.cardId,
          deletedAt: change.deletedAt,
        },
      };
    default:
      return assertNever(change, 'Unsupported Sync v2 journal change');
  }
}
