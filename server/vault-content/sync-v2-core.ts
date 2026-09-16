import type { ConflictId } from '../../lib/domain/id';
import { parseSyncSequence } from '../../lib/sync/v2-protocol';
import type { VaultCardIndexRecord, VaultConflictIndexRecord } from './records';
import type {
  SyncV2CardHead,
  SyncV2JournalChange,
  SyncV2JournalCommit,
  SyncV2JournalCommitResult,
  SyncV2JournalPage,
  SyncV2JournalReceipt,
} from './sync-v2-public';

export type SyncV2JournalState = {
  readonly nextDisplayId: number;
  readonly nextSequence: number;
};

export type SyncV2JournalSnapshot = {
  readonly state: SyncV2JournalState;
  readonly existingReceipt: SyncV2JournalReceipt | undefined;
  readonly card: SyncV2CardHead | undefined;
  readonly selectedConflicts: readonly VaultConflictIndexRecord[];
  readonly allCardConflicts: readonly VaultConflictIndexRecord[];
};

export type SyncV2JournalCommitPlan =
  | Extract<SyncV2JournalCommitResult, { readonly kind: 'replayed' }>
  | Extract<SyncV2JournalCommitResult, { readonly kind: 'not-applied' }>
  | {
      readonly kind: 'commit';
      readonly receipt: SyncV2JournalReceipt;
      readonly expectedState: SyncV2JournalState;
      readonly nextState: SyncV2JournalState;
      readonly officialDisplayId: number | null;
      readonly changes: readonly SyncV2JournalChange[];
    };

export type SyncV2JournalPagePlan =
  | { readonly kind: 'ready'; readonly page: SyncV2JournalPage }
  | { readonly kind: 'rejected' };

export function planSyncV2JournalPage(input: {
  readonly afterSequence: SyncV2JournalPage['highWatermark'];
  readonly highWatermark: SyncV2JournalPage['highWatermark'];
  readonly candidates: readonly SyncV2JournalChange[];
  readonly limit: number;
}): SyncV2JournalPagePlan {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.afterSequence > input.highWatermark ||
    input.candidates.length > input.limit + 1
  ) {
    return { kind: 'rejected' };
  }
  for (const [index, change] of input.candidates.entries()) {
    if (change.sequence !== input.afterSequence + index + 1) {
      return { kind: 'rejected' };
    }
    if (change.sequence > input.highWatermark) {
      return { kind: 'rejected' };
    }
  }
  const hasMore = input.candidates.length > input.limit;
  const changes = input.candidates.slice(0, input.limit);
  const last = changes.at(-1)?.sequence;
  if (hasMore) {
    if (last === undefined || last >= input.highWatermark) {
      return { kind: 'rejected' };
    }
    return {
      kind: 'ready',
      page: {
        highWatermark: input.highWatermark,
        changes,
        page: { kind: 'more', afterSequence: last },
      },
    };
  }
  if (
    (last === undefined && input.afterSequence !== input.highWatermark) ||
    (last !== undefined && last !== input.highWatermark)
  ) {
    return { kind: 'rejected' };
  }
  return {
    kind: 'ready',
    page: {
      highWatermark: input.highWatermark,
      changes,
      page: { kind: 'complete', afterSequence: input.highWatermark },
    },
  };
}

export function planSyncV2JournalCommit(
  command: SyncV2JournalCommit,
  snapshot: SyncV2JournalSnapshot,
): SyncV2JournalCommitPlan {
  if (!validState(snapshot.state)) return rejected('invalid-state');
  if (!validTimestamp(command.committedAt)) return rejected('invalid-timeline');
  if (snapshot.existingReceipt !== undefined) {
    return snapshot.existingReceipt.fingerprint === command.fingerprint
      ? { kind: 'replayed', receipt: snapshot.existingReceipt }
      : rejected('idempotency-key-reuse');
  }

  const operation = planOperation(command, snapshot);
  if (operation.kind === 'not-applied') return operation;
  const nextSequence = snapshot.state.nextSequence + operation.changes.length;
  if (!Number.isSafeInteger(nextSequence)) return rejected('invalid-state');
  const nextDisplayId =
    operation.officialDisplayId === null
      ? snapshot.state.nextDisplayId
      : snapshot.state.nextDisplayId + 1;
  if (!Number.isSafeInteger(nextDisplayId)) return rejected('invalid-state');

  const changes = operation.changes.map((change, index) =>
    assignSequence(change, snapshot.state.nextSequence + index),
  );
  return {
    kind: 'commit',
    receipt: {
      mutationId: command.mutationId,
      fingerprint: command.fingerprint,
      cardId: command.cardId,
      appliedRevision: operation.appliedRevision,
      committedAt: command.committedAt,
    },
    expectedState: snapshot.state,
    nextState: { nextDisplayId, nextSequence },
    officialDisplayId: operation.officialDisplayId,
    changes,
  };
}

type PlannedOperation =
  | Extract<SyncV2JournalCommitPlan, { readonly kind: 'not-applied' }>
  | {
      readonly kind: 'accepted';
      readonly appliedRevision: SyncV2JournalReceipt['appliedRevision'];
      readonly officialDisplayId: number | null;
      readonly changes: readonly UnsequencedChange[];
    };

type UnsequencedChange =
  | Omit<
      Extract<SyncV2JournalChange, { readonly kind: 'card-upsert' }>,
      'sequence'
    >
  | Omit<
      Extract<SyncV2JournalChange, { readonly kind: 'card-tombstone' }>,
      'sequence'
    >
  | Omit<
      Extract<SyncV2JournalChange, { readonly kind: 'conflict-upsert' }>,
      'sequence'
    >
  | Omit<
      Extract<SyncV2JournalChange, { readonly kind: 'conflict-tombstone' }>,
      'sequence'
    >;

function planOperation(
  command: SyncV2JournalCommit,
  snapshot: SyncV2JournalSnapshot,
): PlannedOperation {
  switch (command.kind) {
    case 'card-upsert':
      return planCardUpsert(command, snapshot.card, snapshot.state);
    case 'conflict-upsert':
      return planConflictUpsert(command, snapshot);
    case 'resolve-conflicts':
      return planResolve(command, snapshot);
    case 'card-delete':
      return planCardDelete(command, snapshot);
  }
}

function planCardUpsert(
  command: Extract<SyncV2JournalCommit, { readonly kind: 'card-upsert' }>,
  card: SyncV2CardHead | undefined,
  state: SyncV2JournalState,
): PlannedOperation {
  if (!validTimestamp(command.updatedAt)) return rejected('invalid-timeline');
  if (command.committedAt < command.updatedAt) {
    return rejected('invalid-timeline');
  }
  if (card === undefined) {
    if (command.expectedRevision !== null) return rejected('missing-card');
    if (command.nextRevision !== 1) return rejected('invalid-next-revision');
    return {
      kind: 'accepted',
      appliedRevision: command.nextRevision,
      officialDisplayId: state.nextDisplayId,
      changes: [
        {
          kind: 'card-upsert',
          cardId: command.cardId,
          officialDisplayId: state.nextDisplayId,
          revision: command.nextRevision,
          occurredAt: command.updatedAt,
        },
      ],
    };
  }
  if (command.expectedRevision === null) return rejected('unexpected-card');
  if (card.revision !== command.expectedRevision) {
    return rejected('stale-revision');
  }
  if (command.nextRevision !== card.revision + 1) {
    return rejected('invalid-next-revision');
  }
  if (command.updatedAt < card.updatedAt) return rejected('invalid-timeline');
  return {
    kind: 'accepted',
    appliedRevision: command.nextRevision,
    officialDisplayId: null,
    changes: [
      {
        kind: 'card-upsert',
        cardId: command.cardId,
        officialDisplayId: card.officialDisplayId,
        revision: command.nextRevision,
        occurredAt: command.updatedAt,
      },
    ],
  };
}

function planConflictUpsert(
  command: Extract<SyncV2JournalCommit, { readonly kind: 'conflict-upsert' }>,
  snapshot: SyncV2JournalSnapshot,
): PlannedOperation {
  if (!validTimestamp(command.createdAt)) return rejected('invalid-timeline');
  if (command.committedAt < command.createdAt) {
    return rejected('invalid-timeline');
  }
  if (snapshot.card === undefined) return rejected('missing-card');
  if (snapshot.card.revision !== command.serverRevision) {
    return rejected('stale-revision');
  }
  if (snapshot.selectedConflicts.length > 0) {
    return rejected('unexpected-conflict');
  }
  return {
    kind: 'accepted',
    appliedRevision: command.serverRevision,
    officialDisplayId: null,
    changes: [
      {
        kind: 'conflict-upsert',
        conflictId: command.conflictId,
        cardId: command.cardId,
        serverRevision: command.serverRevision,
        occurredAt: command.createdAt,
      },
    ],
  };
}

function planResolve(
  command: Extract<SyncV2JournalCommit, { readonly kind: 'resolve-conflicts' }>,
  snapshot: SyncV2JournalSnapshot,
): PlannedOperation {
  if (!validTimestamp(command.updatedAt)) return rejected('invalid-timeline');
  if (command.committedAt < command.updatedAt) {
    return rejected('invalid-timeline');
  }
  if (snapshot.card === undefined) return rejected('missing-card');
  if (snapshot.card.revision !== command.expectedRevision) {
    return rejected('stale-revision');
  }
  if (command.nextRevision !== command.expectedRevision + 1) {
    return rejected('invalid-next-revision');
  }
  if (command.updatedAt < snapshot.card.updatedAt) {
    return rejected('invalid-timeline');
  }
  if (new Set(command.conflictIds).size !== command.conflictIds.length) {
    return rejected('missing-conflict');
  }
  const conflicts = new Map(
    snapshot.selectedConflicts.map((conflict) => [
      conflict.conflictId,
      conflict,
    ]),
  );
  const resolvedConflicts: VaultConflictIndexRecord[] = [];
  for (const conflictId of command.conflictIds) {
    const conflict = conflicts.get(conflictId);
    if (conflict === undefined) return rejected('missing-conflict');
    if (conflict.cardId !== command.cardId) {
      return rejected('conflict-card-mismatch');
    }
    resolvedConflicts.push(conflict);
  }
  return {
    kind: 'accepted',
    appliedRevision: command.nextRevision,
    officialDisplayId: null,
    changes: [
      {
        kind: 'card-upsert',
        cardId: command.cardId,
        officialDisplayId: snapshot.card.officialDisplayId,
        revision: command.nextRevision,
        occurredAt: command.updatedAt,
      },
      ...resolvedConflicts.map((conflict) => ({
        kind: 'conflict-tombstone' as const,
        conflictId: conflict.conflictId,
        cardId: command.cardId,
        serverRevision: conflict.serverRevision,
        deletedAt: command.updatedAt,
      })),
    ],
  };
}

function planCardDelete(
  command: Extract<SyncV2JournalCommit, { readonly kind: 'card-delete' }>,
  snapshot: SyncV2JournalSnapshot,
): PlannedOperation {
  if (!validTimestamp(command.deletedAt)) return rejected('invalid-timeline');
  if (command.committedAt < command.deletedAt) {
    return rejected('invalid-timeline');
  }
  if (snapshot.card === undefined) return rejected('missing-card');
  if (snapshot.card.revision !== command.expectedRevision) {
    return rejected('stale-revision');
  }
  if (command.tombstoneRevision !== command.expectedRevision + 1) {
    return rejected('invalid-next-revision');
  }
  if (command.deletedAt < snapshot.card.updatedAt) {
    return rejected('invalid-timeline');
  }
  const orderedConflicts = [...snapshot.allCardConflicts].sort((left, right) =>
    left.conflictId.localeCompare(right.conflictId),
  );
  if (orderedConflicts.some((conflict) => conflict.cardId !== command.cardId)) {
    return rejected('conflict-card-mismatch');
  }
  return {
    kind: 'accepted',
    appliedRevision: command.tombstoneRevision,
    officialDisplayId: null,
    changes: [
      ...orderedConflicts.map((conflict) => ({
        kind: 'conflict-tombstone' as const,
        conflictId: conflict.conflictId,
        cardId: command.cardId,
        serverRevision: conflict.serverRevision,
        deletedAt: command.deletedAt,
      })),
      {
        kind: 'card-tombstone',
        cardId: command.cardId,
        revision: command.tombstoneRevision,
        deletedAt: command.deletedAt,
      },
    ],
  };
}

function rejected(
  reason: Extract<
    SyncV2JournalCommitResult,
    { readonly kind: 'not-applied' }
  >['reason'],
): Extract<SyncV2JournalCommitPlan, { readonly kind: 'not-applied' }> {
  return { kind: 'not-applied', reason };
}

function validState(state: SyncV2JournalState): boolean {
  return (
    Number.isSafeInteger(state.nextDisplayId) &&
    state.nextDisplayId > 0 &&
    state.nextDisplayId <= 2_147_483_647 &&
    Number.isSafeInteger(state.nextSequence) &&
    state.nextSequence > 0
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assignSequence(
  change: UnsequencedChange,
  sequence: number,
): SyncV2JournalChange {
  const parsedSequence = parseSyncSequence(sequence);
  switch (change.kind) {
    case 'card-upsert':
    case 'card-tombstone':
    case 'conflict-upsert':
    case 'conflict-tombstone':
      return { ...change, sequence: parsedSequence };
  }
}

export function selectConflicts(
  conflicts: readonly VaultConflictIndexRecord[],
  ids: readonly ConflictId[],
): readonly VaultConflictIndexRecord[] {
  const requested = new Set(ids);
  return conflicts.filter((conflict) => requested.has(conflict.conflictId));
}

export function toCardHead(
  card: VaultCardIndexRecord,
  officialDisplayId: number,
): SyncV2CardHead {
  return { ...card, officialDisplayId };
}
