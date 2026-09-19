import { describe, expect, it } from 'vitest';
import { parseMutationId } from '@/lib/domain/id';
import type { PendingMutation } from '@/lib/domain/types';
import {
  createLocalMutationDraft,
  legacyMutationDraft,
  selectEligibleMutationDrafts,
} from '@/lib/sync/outgoing-batch';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';

const successorId = parseMutationId('01991f20-61d2-7000-8000-000000000081');
const resolveId = parseMutationId('01991f20-61d2-7000-8000-000000000082');

describe('outgoing batch draft policy', () => {
  it('keeps an edit made during a request causally attached to the outgoing mutation', () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    if (card === undefined) throw new Error('missing card fixture');

    const result = createLocalMutationDraft({
      card: {
        ...card,
        title: '送信中に続けた編集',
        localRevision: card.localRevision + 1,
        updatedAt: card.updatedAt + 1,
      },
      mutationId: successorId,
      mode: { kind: 'upsert' },
      existingDraft: undefined,
      outgoingMutation: fixture.mutation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.mutation).toMatchObject({
      mutationId: successorId,
      baseServerRevision: fixture.mutation.baseServerRevision,
      title: '送信中に続けた編集',
    });
    expect(result.draft.origin).toEqual({
      version: 1,
      baseServerRevision: fixture.mutation.baseServerRevision,
      predecessorMutationId: fixture.mutation.mutationId,
    });
  });

  it('starts an explicit conflict resolution from the selected server revision', () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    if (card === undefined) throw new Error('missing card fixture');
    const existing = {
      mutation: {
        ...fixture.mutation,
        mutationId: successorId,
        title: '競合前の継続編集',
      },
      origin: {
        version: 1 as const,
        baseServerRevision: fixture.mutation.baseServerRevision,
        predecessorMutationId: fixture.mutation.mutationId,
      },
    };

    const result = createLocalMutationDraft({
      card: { ...card, serverRevision: 4 },
      mutationId: resolveId,
      mode: { kind: 'resolve', conflictIds: [fixture.conflict.id] },
      existingDraft: existing,
      outgoingMutation: fixture.mutation,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.mutation).toMatchObject({
      mutationId: resolveId,
      kind: 'resolve',
      baseServerRevision: 4,
      conflictIds: [fixture.conflict.id],
    });
    expect(result.draft.origin).toEqual({
      version: 1,
      baseServerRevision: 4,
      predecessorMutationId: null,
    });
  });

  it('blocks ordinary conflicted drafts but keeps resolutions eligible', () => {
    const fixture = createCompatibilityFixture();
    const resolve: PendingMutation = {
      ...fixture.mutation,
      mutationId: resolveId,
      kind: 'resolve',
      baseServerRevision: 1,
      conflictIds: [fixture.conflict.id],
    };

    expect(
      selectEligibleMutationDrafts({
        drafts: [
          legacyMutationDraft(fixture.mutation),
          legacyMutationDraft({
            ...resolve,
            cardId: compatibilityIds.cardB,
          }),
        ],
        conflicts: [fixture.conflict],
        limit: 500,
      }).map((draft) => draft.mutation),
    ).toEqual([
      expect.objectContaining({ mutationId: resolveId, kind: 'resolve' }),
    ]);
  });
});
