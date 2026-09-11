import { nextProvisionalValue } from '@/lib/domain/display-id';
import type { CardId, ConflictId, MutationId } from '@/lib/domain/id';
import {
  nonNegativeSafeInteger,
  positiveSafeInteger,
  type BodySegment,
  type CardRecord,
  type ConflictRecord,
  type PendingMutation,
} from '@/lib/domain/types';
import { assertNever } from '@/lib/shared/invariant';

export type CardEdit =
  | { type: 'title'; title: string }
  | { type: 'body'; body: BodySegment[] };

export type ConflictResolutionChoice = 'local' | 'server';

export type ConflictResolutionResult =
  | { ok: true; card: CardRecord }
  | { ok: false; reason: 'conflict-card-mismatch' };

export type PendingMutationMode =
  | { kind: 'upsert' }
  | { kind: 'resolve'; conflictIds: [ConflictId, ...ConflictId[]] };

export type PendingMutationResult =
  | { ok: true; mutation: PendingMutation }
  | { ok: false; reason: 'missing-server-revision' };

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

export function resolveCardConflict(
  card: CardRecord,
  conflict: ConflictRecord,
  choice: ConflictResolutionChoice,
  nowInput: number,
): ConflictResolutionResult {
  if (card.id !== conflict.cardId) {
    return { ok: false, reason: 'conflict-card-mismatch' };
  }

  let selected: { title: string; body: BodySegment[] };
  switch (choice) {
    case 'local':
      selected = { title: conflict.localTitle, body: conflict.localBody };
      break;
    case 'server':
      selected = { title: conflict.serverTitle, body: conflict.serverBody };
      break;
    default:
      return assertNever(choice, 'Unsupported conflict resolution choice');
  }
  return {
    ok: true,
    card: {
      ...card,
      ...selected,
      serverRevision: conflict.serverRevision,
      updatedAt: nonNegativeSafeInteger(nowInput, 'card timestamp'),
      localRevision: positiveSafeInteger(
        card.localRevision + 1,
        'local revision',
      ),
    },
  };
}

export function createPendingMutation(
  card: CardRecord,
  mutationId: MutationId,
  mode: PendingMutationMode,
): PendingMutationResult {
  const base = {
    mutationId,
    cardId: card.id,
    title: card.title,
    body: card.body,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };

  switch (mode.kind) {
    case 'upsert':
      return {
        ok: true,
        mutation: {
          ...base,
          kind: mode.kind,
          baseServerRevision: card.serverRevision,
          conflictIds: [],
        },
      };
    case 'resolve':
      if (card.serverRevision === null) {
        return { ok: false, reason: 'missing-server-revision' };
      }
      return {
        ok: true,
        mutation: {
          ...base,
          kind: mode.kind,
          baseServerRevision: card.serverRevision,
          conflictIds: mode.conflictIds,
        },
      };
    default:
      return assertNever(mode, 'Unsupported pending mutation mode');
  }
}
