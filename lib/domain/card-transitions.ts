import { nextProvisionalValue } from '@/lib/domain/display-id';
import type { CardId, ConflictId, MutationId } from '@/lib/domain/id';
import {
  nonNegativeSafeInteger,
  positiveSafeInteger,
  CONTRACT_LIMITS,
  type BodySegment,
  type CardRecord,
  type ConflictRecord,
  type PendingMutation,
} from '@/lib/domain/types';
import { assertNever } from '@/lib/shared/invariant';

export type CardEdit =
  | { type: 'title'; title: string }
  | { type: 'body'; body: BodySegment[] };

export type ConflictResolutionChoice = 'local' | 'server' | 'current';

export type ConflictResolutionResult =
  | {
      ok: true;
      card: CardRecord;
      conflictIds: [ConflictId, ...ConflictId[]];
    }
  | {
      ok: false;
      reason:
        | 'conflict-card-mismatch'
        | 'no-conflicts'
        | 'selected-conflict-missing';
    };

export type PendingMutationMode =
  | { kind: 'upsert' }
  | { kind: 'resolve'; conflictIds: [ConflictId, ...ConflictId[]] };

export type PendingMutationResult =
  | { ok: true; mutation: PendingMutation }
  | {
      ok: false;
      reason:
        | 'conflict-limit-exceeded'
        | 'existing-mutation-card-mismatch'
        | 'missing-server-revision';
    };

export function createLocalCard(input: {
  cards: readonly CardRecord[];
  cardId: CardId;
  now: number;
}): CardRecord {
  const now = nonNegativeSafeInteger(input.now, 'card timestamp');
  return {
    id: input.cardId,
    displayId: {
      kind: 'provisional',
      value: positiveSafeInteger(
        nextProvisionalValue(input.cards),
        'provisional display ID',
      ),
    },
    title: '',
    body: [],
    createdAt: now,
    updatedAt: now,
    localRevision: positiveSafeInteger(1, 'initial local revision'),
    serverRevision: null,
  };
}

export function applyCardEdit(
  card: CardRecord,
  edit: CardEdit,
  nowInput: number,
): CardRecord {
  const next = {
    ...card,
    updatedAt: nonNegativeSafeInteger(nowInput, 'card timestamp'),
    localRevision: positiveSafeInteger(
      card.localRevision + 1,
      'local revision',
    ),
  };

  switch (edit.type) {
    case 'title':
      return { ...next, title: edit.title };
    case 'body':
      return { ...next, body: edit.body };
    default:
      return assertNever(edit, 'Unsupported card edit');
  }
}

export function resolveCardConflicts(
  card: CardRecord,
  conflicts: readonly ConflictRecord[],
  selectedConflictId: ConflictId,
  choice: ConflictResolutionChoice,
  nowInput: number,
): ConflictResolutionResult {
  if (conflicts.length === 0) {
    return { ok: false, reason: 'no-conflicts' };
  }

  const conflictIds: ConflictId[] = [];
  const seen = new Set<ConflictId>();
  let selectedConflict: ConflictRecord | undefined;
  let latestKnownServerRevision = card.serverRevision ?? 0;
  for (const conflict of conflicts) {
    if (card.id !== conflict.cardId) {
      return { ok: false, reason: 'conflict-card-mismatch' };
    }
    if (conflict.id === selectedConflictId) selectedConflict = conflict;
    if (!seen.has(conflict.id)) {
      seen.add(conflict.id);
      conflictIds.push(conflict.id);
    }
    latestKnownServerRevision = Math.max(
      latestKnownServerRevision,
      conflict.serverRevision,
    );
  }
  if (!selectedConflict) {
    return { ok: false, reason: 'selected-conflict-missing' };
  }
  const [firstConflictId, ...remainingConflictIds] = conflictIds;
  if (!firstConflictId) return { ok: false, reason: 'no-conflicts' };

  let selected: { title: string; body: BodySegment[] };
  switch (choice) {
    case 'local':
      selected = {
        title: selectedConflict.localTitle,
        body: selectedConflict.localBody,
      };
      break;
    case 'server':
      selected = {
        title: selectedConflict.serverTitle,
        body: selectedConflict.serverBody,
      };
      break;
    case 'current':
      selected = { title: card.title, body: card.body };
      break;
    default:
      return assertNever(choice, 'Unsupported conflict resolution choice');
  }
  return {
    ok: true,
    card: {
      ...card,
      ...selected,
      serverRevision: positiveSafeInteger(
        latestKnownServerRevision,
        'latest known server revision',
      ),
      updatedAt: nonNegativeSafeInteger(nowInput, 'card timestamp'),
      localRevision: positiveSafeInteger(
        card.localRevision + 1,
        'local revision',
      ),
    },
    conflictIds: [firstConflictId, ...remainingConflictIds],
  };
}

function combinedConflictIds(
  existing: PendingMutation | undefined,
  requested: readonly ConflictId[],
): [ConflictId, ...ConflictId[]] | null {
  const combined: ConflictId[] = [];
  const seen = new Set<ConflictId>();
  const append = (conflictId: ConflictId) => {
    if (seen.has(conflictId)) return;
    seen.add(conflictId);
    combined.push(conflictId);
  };
  if (existing?.kind === 'resolve') {
    for (const conflictId of existing.conflictIds) append(conflictId);
  }
  for (const conflictId of requested) append(conflictId);
  if (combined.length > CONTRACT_LIMITS.conflictIds) return null;
  const [first, ...rest] = combined;
  return first ? [first, ...rest] : null;
}

export function createPendingMutation(
  card: CardRecord,
  mutationId: MutationId,
  mode: PendingMutationMode,
  existing?: PendingMutation,
): PendingMutationResult {
  if (existing && existing.cardId !== card.id) {
    return { ok: false, reason: 'existing-mutation-card-mismatch' };
  }
  const base = {
    mutationId,
    cardId: card.id,
    title: card.title,
    body: card.body,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };

  switch (mode.kind) {
    case 'upsert': {
      if (existing?.kind === 'resolve') {
        if (card.serverRevision === null) {
          return { ok: false, reason: 'missing-server-revision' };
        }
        return {
          ok: true,
          mutation: {
            ...base,
            kind: 'resolve',
            baseServerRevision: card.serverRevision,
            conflictIds: existing.conflictIds,
          },
        };
      }
      return {
        ok: true,
        mutation: {
          ...base,
          kind: mode.kind,
          baseServerRevision: card.serverRevision,
          conflictIds: [],
        },
      };
    }
    case 'resolve': {
      if (card.serverRevision === null) {
        return { ok: false, reason: 'missing-server-revision' };
      }
      const conflictIds = combinedConflictIds(existing, mode.conflictIds);
      if (!conflictIds) {
        return { ok: false, reason: 'conflict-limit-exceeded' };
      }
      return {
        ok: true,
        mutation: {
          ...base,
          kind: mode.kind,
          baseServerRevision: card.serverRevision,
          conflictIds,
        },
      };
    }
    default:
      return assertNever(mode, 'Unsupported pending mutation mode');
  }
}
