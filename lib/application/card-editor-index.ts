import { linkCandidates } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import type { CardId } from '@/lib/domain/id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';

export type CardEditorIndexLabel = Readonly<{
  cardId: CardId;
  label: string;
}>;

export type CardEditorIndexCandidate = Readonly<{
  cardId: CardId;
  displayLabel: string;
  displayValue: number;
  title: string;
}>;

type CardEditorIndexSource = Readonly<{
  cardId: CardId;
  displayKind: CardRecord['displayId']['kind'];
  displayValue: number;
  title: string;
  createdAt: number;
}>;

export type CardEditorCandidateIndex = Readonly<{
  currentCardId: CardId;
  sources: readonly CardEditorIndexSource[];
  labels: readonly CardEditorIndexLabel[];
  candidatesByPrefix: ReadonlyMap<string, readonly CardEditorIndexCandidate[]>;
}>;

const emptyCandidates: readonly CardEditorIndexCandidate[] = [];
const maximumDisplayIdDigits = String(Number.MAX_SAFE_INTEGER).length;
export const maximumCardEditorCandidateResults = 9_999;

function indexSource(card: CardRecord): CardEditorIndexSource {
  return {
    cardId: card.id,
    displayKind: card.displayId.kind,
    displayValue: card.displayId.value,
    title: card.title,
    createdAt: card.createdAt,
  };
}

function sourceMatches(
  source: CardEditorIndexSource,
  card: CardRecord,
): boolean {
  return (
    source.cardId === card.id &&
    source.displayKind === card.displayId.kind &&
    source.displayValue === card.displayId.value &&
    source.title === card.title &&
    source.createdAt === card.createdAt
  );
}

function indexStillMatches(
  index: CardEditorCandidateIndex,
  cards: readonly CardRecord[],
  currentCardId: CardId,
): boolean {
  if (
    index.currentCardId !== currentCardId ||
    index.sources.length !== cards.length
  ) {
    return false;
  }
  return index.sources.every((source, position) => {
    const card = cards[position];
    return card !== undefined && sourceMatches(source, card);
  });
}

function candidateModel(card: CardRecord): CardEditorIndexCandidate {
  return {
    cardId: card.id,
    displayLabel: formatDisplayId(card.displayId),
    displayValue: card.displayId.value,
    title: visibleTitle(card.title),
  };
}

function prefixBuckets(
  candidates: readonly CardEditorIndexCandidate[],
): ReadonlyMap<string, readonly CardEditorIndexCandidate[]> {
  const builders = new Map<string, CardEditorIndexCandidate[]>([['', []]]);
  for (const candidate of candidates) {
    const allCandidates = builders.get('');
    if (
      allCandidates &&
      allCandidates.length < maximumCardEditorCandidateResults
    ) {
      allCandidates.push(candidate);
    }
    const displayValue = String(candidate.displayValue);
    for (let length = 1; length <= displayValue.length; length += 1) {
      const prefix = displayValue.slice(0, length);
      const bucket = builders.get(prefix);
      if (bucket) {
        if (bucket.length < maximumCardEditorCandidateResults) {
          bucket.push(candidate);
        }
      } else {
        builders.set(prefix, [candidate]);
      }
    }
  }
  return new Map(
    [...builders].map(([prefix, values]) => [
      prefix,
      Object.freeze([...values]),
    ]),
  );
}

export function createCardEditorCandidateIndex(
  cards: readonly CardRecord[],
  currentCardId: CardId,
): CardEditorCandidateIndex {
  const candidates = linkCandidates(cards, currentCardId).map(candidateModel);
  return {
    currentCardId,
    sources: Object.freeze(cards.map(indexSource)),
    labels: Object.freeze(
      cards.map((card) => ({
        cardId: card.id,
        label: `${formatDisplayId(card.displayId)} ${visibleTitle(card.title)}`,
      })),
    ),
    candidatesByPrefix: prefixBuckets(candidates),
  };
}

export function reconcileCardEditorCandidateIndex(
  current: CardEditorCandidateIndex | null,
  cards: readonly CardRecord[],
  currentCardId: CardId,
): CardEditorCandidateIndex {
  return current && indexStillMatches(current, cards, currentCardId)
    ? current
    : createCardEditorCandidateIndex(cards, currentCardId);
}

export function queryCardEditorCandidates(
  index: CardEditorCandidateIndex,
  numberPrefix: string,
): readonly CardEditorIndexCandidate[] {
  if (
    numberPrefix.length > maximumDisplayIdDigits ||
    !/^\d*$/u.test(numberPrefix)
  ) {
    return emptyCandidates;
  }
  return index.candidatesByPrefix.get(numberPrefix) ?? emptyCandidates;
}
