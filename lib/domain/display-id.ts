import { positiveSafeInteger, type CardRecord, type DisplayId } from './types';
import { invariant } from '@/lib/shared/invariant';

export function formatDisplayId(displayId: DisplayId): string {
  return displayId.kind === 'provisional'
    ? `仮 #${displayId.value}`
    : `#${displayId.value}`;
}

export function nextProvisionalValue(cards: readonly CardRecord[]): number {
  return positiveSafeInteger(
    cards.reduce(
      (maximum, card) => Math.max(maximum, card.displayId.value),
      0,
    ) + 1,
    'next provisional display ID',
  );
}

export function sortCardsByDisplayId(
  cards: readonly CardRecord[],
): CardRecord[] {
  return [...cards].sort((left, right) => {
    const byNumber = left.displayId.value - right.displayId.value;
    if (byNumber !== 0) return byNumber;
    if (left.displayId.kind !== right.displayId.kind) {
      return left.displayId.kind === 'official' ? -1 : 1;
    }
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
  });
}

export function reconcileProvisionalDisplayIds(
  cards: readonly CardRecord[],
): CardRecord[] {
  const official = cards.filter((card) => card.displayId.kind === 'official');
  const provisional = cards
    .filter((card) => card.displayId.kind === 'provisional')
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  const firstAvailable = positiveSafeInteger(
    official.reduce(
      (maximum, card) => Math.max(maximum, card.displayId.value),
      0,
    ) + 1,
    'first provisional display ID',
  );
  const assigned = new Map(
    provisional.map((card, index) => [
      card.id,
      positiveSafeInteger(
        firstAvailable + index,
        'reconciled provisional display ID',
      ),
    ]),
  );

  return cards.map((card) => {
    if (card.displayId.kind === 'official') return card;
    const value = assigned.get(card.id);
    invariant(value, `Missing provisional display ID for card ${card.id}`);
    if (card.displayId.value === value) return card;
    return { ...card, displayId: { kind: 'provisional', value } };
  });
}
