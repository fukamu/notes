import { formatDisplayId } from '@/lib/domain/display-id';
import type { CardId } from '@/lib/domain/id';
import {
  visibleTitle,
  type BodySegment,
  type CardRecord,
} from '@/lib/domain/types';

export type CardBodyTextLookup = ReadonlyMap<CardId, string>;

export function createCardBodyTextLookup(
  cards: readonly CardRecord[],
): CardBodyTextLookup {
  return new Map(
    cards.map((card) => [
      card.id,
      `${formatDisplayId(card.displayId)} ${visibleTitle(card.title)}`,
    ]),
  );
}

export function bodyToPlainTextFromLookup(
  body: readonly BodySegment[],
  lookup: CardBodyTextLookup,
): string {
  return body
    .map((segment) => {
      if (segment.type === 'text') return segment.text;
      const target = lookup.get(segment.targetCardId);
      return target ? `［${target}］` : '［リンク先なし］';
    })
    .join('');
}
