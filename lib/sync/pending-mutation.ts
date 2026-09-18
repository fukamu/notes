import type { PendingMutation } from '@/lib/domain/types';
import { assertNever } from '@/lib/shared/invariant';

/**
 * Rebases a mutation that was saved after a sync request captured its input.
 * If that request acknowledged an earlier resolve for the same card, conflict
 * IDs consumed by the acknowledgement must not be sent again. The newer local
 * content remains pending as an ordinary upsert once every resolve ID was
 * consumed.
 */
export function rebasePendingMutationAfterSync(input: {
  readonly mutation: PendingMutation;
  readonly serverRevision: number;
  readonly acknowledgedMutation: PendingMutation | undefined;
}): PendingMutation {
  const { mutation, serverRevision, acknowledgedMutation } = input;
  switch (mutation.kind) {
    case 'upsert':
      return { ...mutation, baseServerRevision: serverRevision };
    case 'resolve': {
      if (
        acknowledgedMutation?.kind !== 'resolve' ||
        acknowledgedMutation.cardId !== mutation.cardId
      ) {
        return { ...mutation, baseServerRevision: serverRevision };
      }
      const acknowledgedIds = new Set(acknowledgedMutation.conflictIds);
      const remaining = mutation.conflictIds.filter(
        (conflictId) => !acknowledgedIds.has(conflictId),
      );
      const [first, ...rest] = remaining;
      if (!first) {
        return {
          mutationId: mutation.mutationId,
          cardId: mutation.cardId,
          kind: 'upsert',
          baseServerRevision: serverRevision,
          title: mutation.title,
          body: mutation.body,
          createdAt: mutation.createdAt,
          updatedAt: mutation.updatedAt,
          conflictIds: [],
        };
      }
      return {
        ...mutation,
        baseServerRevision: serverRevision,
        conflictIds: [first, ...rest],
      };
    }
    default:
      return assertNever(mutation, 'Unsupported pending mutation rebase');
  }
}
