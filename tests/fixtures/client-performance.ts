import { parseCardId, type CardId } from '@/lib/domain/id';
import {
  CONTRACT_LIMITS,
  type BodySegment,
  type CardRecord,
} from '@/lib/domain/types';

export type ClientPerformanceFixtureOptions = Readonly<{
  cardCount: number;
  seed: number;
  textCharacters: number;
}>;

export const clientPerformanceFixtureDefaults = {
  cardCount: 10_000,
  seed: 0x1260cafe,
  textCharacters: 768,
} as const satisfies ClientPerformanceFixtureOptions;

function fixtureCardId(index: number): CardId {
  const tail = (index + 1).toString(16).padStart(12, '0');
  return parseCardId(`01991f20-61d2-7000-8000-${tail}`);
}

function performanceText(index: number, characters: number): string {
  const prefix = `Card ${String(index + 1).padStart(5, '0')} `;
  if (prefix.length >= characters) return prefix.slice(0, characters);
  return prefix + '深'.repeat(characters - prefix.length);
}

function nextSeed(state: number): number {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function linkedCardIndex(
  sourceIndex: number,
  cardCount: number,
  randomValue: number,
): number | null {
  if (cardCount <= 1) return null;
  const candidate = randomValue % (cardCount - 1);
  return candidate >= sourceIndex ? candidate + 1 : candidate;
}

function fixtureBody(
  sourceIndex: number,
  ids: readonly CardId[],
  missingTargetId: CardId,
  text: string,
  randomValue: number,
): BodySegment[] {
  const firstTarget = ids[(sourceIndex + 1) % ids.length];
  const randomTargetIndex = linkedCardIndex(
    sourceIndex,
    ids.length,
    randomValue,
  );
  if (!firstTarget || randomTargetIndex === null) {
    return [{ type: 'text', text }];
  }
  const randomTarget =
    sourceIndex % 211 === 0 ? missingTargetId : ids[randomTargetIndex];
  if (!randomTarget) return [{ type: 'text', text }];
  const split = Math.floor(text.length / 2);
  return [
    { type: 'text', text: text.slice(0, split) },
    { type: 'link', targetCardId: firstTarget },
    { type: 'text', text: text.slice(split) },
    { type: 'link', targetCardId: randomTarget },
  ];
}

export function createClientPerformanceFixture(
  options: ClientPerformanceFixtureOptions = clientPerformanceFixtureDefaults,
): CardRecord[] {
  if (
    !Number.isSafeInteger(options.cardCount) ||
    options.cardCount < 0 ||
    options.cardCount > CONTRACT_LIMITS.cards
  ) {
    throw new RangeError(
      `cardCount must be an integer from 0 to ${CONTRACT_LIMITS.cards}`,
    );
  }
  if (
    !Number.isSafeInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff
  ) {
    throw new RangeError('seed must be an unsigned 32-bit integer');
  }
  if (
    !Number.isSafeInteger(options.textCharacters) ||
    options.textCharacters < 0 ||
    options.textCharacters > 1_000
  ) {
    throw new RangeError('textCharacters must be an integer from 0 to 1000');
  }

  const ids = Array.from({ length: options.cardCount }, (_, index) =>
    fixtureCardId(index),
  );
  const missingTargetId = fixtureCardId(options.cardCount);
  let randomState = options.seed >>> 0;

  return ids.map((id, index) => {
    randomState = nextSeed(randomState);
    const provisional = (index + 1) % 97 === 0;
    return {
      id,
      displayId: {
        kind: provisional ? 'provisional' : 'official',
        value: index + 1,
      },
      title: `Performance card ${String(index + 1).padStart(5, '0')}`,
      body: fixtureBody(
        index,
        ids,
        missingTargetId,
        performanceText(index, options.textCharacters),
        randomState,
      ),
      createdAt: index + 1,
      updatedAt: index + 1,
      localRevision: 1,
      serverRevision: provisional ? null : 1,
    };
  });
}
