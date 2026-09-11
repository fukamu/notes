import {
  parseCardId,
  parseConflictId,
  parseMutationId,
  type CardId,
  type ConflictId,
  type MutationId,
} from '@/lib/domain/id';

export function fixtureCardId(label: string): CardId {
  let hash = 2_166_136_261;
  for (const character of label) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  const tail = (hash >>> 0).toString(16).padStart(12, '0');
  return parseCardId(`01991f20-61d2-7000-8000-${tail}`);
}

export function fixtureConflictId(label: string): ConflictId {
  const cardId = fixtureCardId(`conflict-${label}`);
  return parseConflictId(cardId);
}

export function fixtureMutationId(label: string): MutationId {
  const cardId = fixtureCardId(`mutation-${label}`);
  return parseMutationId(cardId);
}
