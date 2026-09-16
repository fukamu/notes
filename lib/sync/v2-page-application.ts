import { BoundaryDecodeError, type DecodeIssue } from '@/lib/codec/core';
import type { PendingMutation } from '@/lib/domain/types';
import {
  decodeSyncV2Response,
  type SyncSequence,
  type SyncV2Change,
  type SyncV2Cursor,
  type SyncV2MutationReceipt,
} from '@/lib/sync/v2-protocol';

export type SyncV2Checkpoint = {
  readonly cursor: SyncV2Cursor | null;
  readonly highWatermark: SyncSequence;
};

export type SyncV2PageCollection = {
  readonly checkpoint: SyncV2Checkpoint;
  readonly nextRequestCursor: SyncV2Cursor | null;
  readonly highWatermark: SyncSequence | null;
  readonly lastSequence: SyncSequence;
  readonly changes: readonly SyncV2Change[];
  readonly receipts: readonly SyncV2MutationReceipt[];
  readonly sentMutations: readonly PendingMutation[];
};

export type SyncV2CommitPlan = {
  readonly previousCheckpoint: SyncV2Checkpoint;
  readonly nextCheckpoint: SyncV2Checkpoint;
  readonly changes: readonly SyncV2Change[];
  readonly receipts: readonly SyncV2MutationReceipt[];
};

export type SyncV2PageDecision =
  | {
      readonly kind: 'continue';
      readonly state: SyncV2PageCollection;
    }
  | {
      readonly kind: 'ready-to-commit';
      readonly state: SyncV2PageCollection;
      readonly plan: SyncV2CommitPlan;
    }
  | {
      readonly kind: 'rejected';
      readonly state: SyncV2PageCollection;
      readonly reason:
        | 'malformed-page'
        | 'cursor-mismatch'
        | 'non-advancing-cursor'
        | 'high-watermark-rewind'
        | 'high-watermark-changed'
        | 'sequence-reordered'
        | 'receipt-changed';
      readonly issues?: readonly DecodeIssue[];
    };

export type MutationReceiptReplayPlan =
  | { readonly kind: 'apply' }
  | {
      readonly kind: 'replay';
      readonly receipt: SyncV2MutationReceipt;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'mutation-card-mismatch';
    };

export function beginSyncV2PageCollection(input: {
  readonly checkpoint: SyncV2Checkpoint;
  readonly sentMutations: readonly PendingMutation[];
}): SyncV2PageCollection {
  return {
    checkpoint: input.checkpoint,
    nextRequestCursor: input.checkpoint.cursor,
    highWatermark: null,
    lastSequence: input.checkpoint.highWatermark,
    changes: [],
    receipts: [],
    sentMutations: [...input.sentMutations],
  };
}

function sameCursor(
  left: SyncV2Cursor | null,
  right: SyncV2Cursor | null,
): boolean {
  return left === right;
}

function sameReceipt(
  left: SyncV2MutationReceipt,
  right: SyncV2MutationReceipt,
): boolean {
  return (
    left.mutationId === right.mutationId &&
    left.cardId === right.cardId &&
    left.appliedRevision === right.appliedRevision
  );
}

function mergeReceipts(
  existing: readonly SyncV2MutationReceipt[],
  incoming: readonly SyncV2MutationReceipt[],
): readonly SyncV2MutationReceipt[] | undefined {
  const byMutation = new Map(
    existing.map((receipt) => [receipt.mutationId, receipt]),
  );
  const merged = [...existing];
  for (const receipt of incoming) {
    const prior = byMutation.get(receipt.mutationId);
    if (prior !== undefined) {
      if (!sameReceipt(prior, receipt)) return undefined;
      continue;
    }
    byMutation.set(receipt.mutationId, receipt);
    merged.push(receipt);
  }
  return merged;
}

export function planSyncV2Page(input: {
  readonly state: SyncV2PageCollection;
  readonly requestCursor: SyncV2Cursor | null;
  readonly response: unknown;
}): SyncV2PageDecision {
  if (!sameCursor(input.requestCursor, input.state.nextRequestCursor)) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'cursor-mismatch',
    };
  }

  let response;
  try {
    response = decodeSyncV2Response(input.response, input.state.sentMutations);
  } catch (error: unknown) {
    if (error instanceof BoundaryDecodeError) {
      return {
        kind: 'rejected',
        state: input.state,
        reason: 'malformed-page',
        issues: error.issues,
      };
    }
    throw error;
  }

  if (response.highWatermark < input.state.checkpoint.highWatermark) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'high-watermark-rewind',
    };
  }
  if (
    input.state.highWatermark !== null &&
    response.highWatermark !== input.state.highWatermark
  ) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'high-watermark-changed',
    };
  }

  const firstChange = response.changes[0];
  if (
    firstChange !== undefined &&
    firstChange.sequence <= input.state.lastSequence
  ) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'sequence-reordered',
    };
  }

  const receipts = mergeReceipts(input.state.receipts, response.receipts);
  if (receipts === undefined) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'receipt-changed',
    };
  }

  if (
    response.page.kind === 'more' &&
    response.page.nextCursor === input.requestCursor
  ) {
    return {
      kind: 'rejected',
      state: input.state,
      reason: 'non-advancing-cursor',
    };
  }

  const lastChange = response.changes.at(-1);
  const changes = [...input.state.changes, ...response.changes];
  const nextState: SyncV2PageCollection = {
    ...input.state,
    nextRequestCursor: response.page.nextCursor,
    highWatermark: response.highWatermark,
    lastSequence: lastChange?.sequence ?? input.state.lastSequence,
    changes,
    receipts,
  };
  if (response.page.kind === 'more') {
    return { kind: 'continue', state: nextState };
  }
  return {
    kind: 'ready-to-commit',
    // The caller keeps this pre-commit state when the storage transaction fails.
    state: input.state,
    plan: {
      previousCheckpoint: input.state.checkpoint,
      nextCheckpoint: {
        cursor: response.page.nextCursor,
        highWatermark: response.highWatermark,
      },
      changes,
      receipts,
    },
  };
}

export function planMutationReceiptReplay(
  mutation: PendingMutation,
  existing: SyncV2MutationReceipt | undefined,
): MutationReceiptReplayPlan {
  if (existing === undefined) return { kind: 'apply' };
  if (existing.cardId !== mutation.cardId) {
    return { kind: 'rejected', reason: 'mutation-card-mismatch' };
  }
  return { kind: 'replay', receipt: existing };
}
