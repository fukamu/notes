import type { BodySegment, CardRecord } from './types';
import type { CardId } from './id';
import { formatDisplayId } from './display-id';
import { visibleTitle } from './types';

export function normalizeBody(segments: BodySegment[]): BodySegment[] {
  const normalized: BodySegment[] = [];

  for (const segment of segments) {
    if (segment.type === 'text') {
      if (segment.text === '') continue;
      const previous = normalized.at(-1);
      if (previous?.type === 'text') {
        previous.text += segment.text;
      } else {
        normalized.push({ type: 'text', text: segment.text });
      }
      continue;
    }

    normalized.push({ type: 'link', targetCardId: segment.targetCardId });
  }

  return normalized;
}

export function bodyToPlainText(
  body: BodySegment[],
  cards: CardRecord[],
): string {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return body
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      const target = byId.get(segment.targetCardId);
      if (!target) return '［リンク先なし］';
      return `［${formatDisplayId(target.displayId)} ${visibleTitle(target.title)}］`;
    })
    .join('');
}

export function outgoingCardIds(body: BodySegment[]): CardId[] {
  return body
    .filter(
      (segment): segment is Extract<BodySegment, { type: 'link' }> =>
        segment.type === 'link',
    )
    .map((segment) => segment.targetCardId);
}

export function linkCandidates(
  cards: readonly CardRecord[],
  currentCardId: CardId,
  numberPrefix = '',
): CardRecord[] {
  if (!/^\d*$/u.test(numberPrefix)) return [];
  return cards
    .map((card, sourceIndex) => ({ card, sourceIndex }))
    .filter(
      ({ card }) =>
        card.id !== currentCardId &&
        String(card.displayId.value).startsWith(numberPrefix),
    )
    .sort((left, right) => {
      const leftValue = left.card.displayId.value;
      const rightValue = right.card.displayId.value;
      if (leftValue !== rightValue) return leftValue < rightValue ? 1 : -1;
      if (left.card.displayId.kind !== right.card.displayId.kind) {
        return left.card.displayId.kind === 'official' ? -1 : 1;
      }
      const byCreatedAt = left.card.createdAt - right.card.createdAt;
      if (byCreatedAt !== 0) return byCreatedAt;
      const byId = left.card.id.localeCompare(right.card.id);
      return byId !== 0 ? byId : left.sourceIndex - right.sourceIndex;
    })
    .map(({ card }) => card);
}
