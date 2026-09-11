import type { CardEditorLabelModel } from '@/lib/application/presentation';
import type { CardId } from '@/lib/domain/id';

export type CardLabelResolver = {
  labelFor: (cardId: CardId) => string;
  replaceLabels: (labels: CardEditorLabelModel[]) => void;
  subscribe: (listener: () => void) => () => void;
  destroy: () => void;
};

function labelMap(labels: CardEditorLabelModel[]): Map<CardId, string> {
  return new Map(labels.map((item) => [item.cardId, item.label]));
}

export function createCardLabelResolver(
  initialLabels: CardEditorLabelModel[],
): CardLabelResolver {
  let labels = labelMap(initialLabels);
  let destroyed = false;
  const listeners = new Set<() => void>();

  return {
    labelFor: (cardId) => labels.get(cardId) ?? 'リンク先なし',
    replaceLabels: (nextLabels) => {
      if (destroyed) return;
      labels = labelMap(nextLabels);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      destroyed = true;
      labels.clear();
      listeners.clear();
    },
  };
}
