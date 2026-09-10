import { describe, expect, it } from 'vitest';
import {
  reconcileProvisionalDisplayIds,
  sortCardsByDisplayId,
} from '@/lib/domain/display-id';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';

function card(
  id: string,
  kind: 'official' | 'provisional',
  value: number,
  createdAt: number,
): CardRecord {
  return {
    id,
    displayId: { kind, value },
    title: '',
    body: [],
    createdAt,
    updatedAt: createdAt,
    localRevision: 1,
    serverRevision: kind === 'official' ? 1 : null,
  };
}

describe('display ids', () => {
  it('sorts by displayed number even when internal id order differs', () => {
    const cards = [
      card('0000', 'official', 20, 1),
      card('ffff', 'official', 3, 2),
    ];
    expect(
      sortCardsByDisplayId(cards).map((item) => item.displayId.value),
    ).toEqual([3, 20]);
  });

  it('keeps official ids and renumbers only provisional collisions', () => {
    const cards = [
      card('official', 'official', 2, 5),
      card('older', 'provisional', 2, 10),
      card('newer', 'provisional', 3, 20),
    ];
    const reconciled = reconcileProvisionalDisplayIds(cards);
    expect(
      reconciled.find((item) => item.id === 'official')?.displayId,
    ).toEqual({
      kind: 'official',
      value: 2,
    });
    expect(
      reconciled
        .filter((item) => item.displayId.kind === 'provisional')
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((item) => item.displayId.value),
    ).toEqual([3, 4]);
    expect(new Set(reconciled.map((item) => item.displayId.value)).size).toBe(
      3,
    );
  });

  it('preserves provisional creation order after a later official id arrives', () => {
    const reconciled = reconcileProvisionalDisplayIds([
      card('later', 'provisional', 1, 200),
      card('official', 'official', 8, 50),
      card('earlier', 'provisional', 8, 100),
    ]);
    const earlier = reconciled.find((item) => item.id === 'earlier');
    const later = reconciled.find((item) => item.id === 'later');
    invariant(earlier, 'Earlier provisional card is missing');
    invariant(later, 'Later provisional card is missing');
    expect(earlier.displayId.value).toBeLessThan(later.displayId.value);
    expect(earlier.displayId.value).toBe(9);
    expect(later.displayId.value).toBe(10);
  });
});
