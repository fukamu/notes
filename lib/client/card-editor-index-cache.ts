import {
  reconcileCardEditorCandidateIndex,
  type CardEditorCandidateIndex,
} from '@/lib/application/card-editor-index';
import type { CardId } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';

export type CardEditorIndexCache = {
  select: (
    cards: readonly CardRecord[],
    currentCardId: CardId,
  ) => CardEditorCandidateIndex;
  clear: () => void;
};

export function createCardEditorIndexCache(): CardEditorIndexCache {
  let current: CardEditorCandidateIndex | null = null;
  return {
    select: (cards, currentCardId) => {
      current = reconcileCardEditorCandidateIndex(
        current,
        cards,
        currentCardId,
      );
      return current;
    },
    clear: () => {
      current = null;
    },
  };
}
