import type { BodySegment, CardRecord } from './types';
import { formatDisplayId, sortCardsByDisplayId } from './display-id';
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

export function outgoingCardIds(body: BodySegment[]): string[] {
  return body
    .filter(
      (segment): segment is Extract<BodySegment, { type: 'link' }> =>
        segment.type === 'link',
    )
    .map((segment) => segment.targetCardId);
}

export function linkCandidates(
  cards: CardRecord[],
  currentCardId: string,
): CardRecord[] {
  return sortCardsByDisplayId(cards).filter(
    (card) => card.id !== currentCardId,
  );
}
