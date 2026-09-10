import { formatDisplayId } from '@/lib/domain/display-id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';

const labels = new Map<string, string>();
const listeners = new Set<() => void>();

export function setCardLabels(cards: CardRecord[]): void {
  labels.clear();
  for (const card of cards) {
    labels.set(card.id, `${formatDisplayId(card.displayId)} ${visibleTitle(card.title)}`);
  }
  for (const listener of listeners) listener();
}

export function getCardLabel(cardId: string): string {
  return labels.get(cardId) ?? 'リンク先なし';
}

export function subscribeToCardLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
