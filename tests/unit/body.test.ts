import { describe, expect, it } from 'vitest';
import { linkCandidates } from '@/lib/domain/body';
import type { CardRecord, DisplayId } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

function card(
  label: string,
  displayId: DisplayId,
  createdAt: number,
): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId,
    title: label,
    body: [],
    createdAt,
    updatedAt: createdAt,
    localRevision: 1,
    serverRevision: displayId.kind === 'official' ? 1 : null,
  };
}

describe('link candidates', () => {
  it.each([0, 1, 9, 10, 99, 100, 105])(
    'sorts %i candidates by numeric display value descending',
    (candidateCount) => {
      const candidates = Array.from({ length: candidateCount }, (_, index) =>
        card(
          `candidate-${index + 1}`,
          { kind: 'official', value: index + 1 },
          index + 1,
        ),
      ).reverse();
      const current = card(
        `current-${candidateCount}`,
        { kind: 'official', value: candidateCount + 1 },
        candidateCount + 1,
      );
      const input = [current, ...candidates];
      const snapshot = structuredClone(input);

      expect(
        linkCandidates(input, current.id).map((item) => item.displayId.value),
      ).toEqual(
        Array.from(
          { length: candidateCount },
          (_, index) => candidateCount - index,
        ),
      );
      expect(input).toEqual(snapshot);
    },
  );

  it('filters numeric prefixes without treating exact matches specially', () => {
    const candidates = Array.from({ length: 105 }, (_, index) =>
      card(
        `prefix-${index + 1}`,
        { kind: 'official', value: index + 1 },
        index + 1,
      ),
    );
    const current = card('prefix-current', { kind: 'official', value: 106 }, 0);

    expect(
      linkCandidates(candidates, current.id, '3').map(
        (item) => item.displayId.value,
      ),
    ).toEqual([39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 3]);
    expect(
      linkCandidates(candidates, current.id, '32').map(
        (item) => item.displayId.value,
      ),
    ).toEqual([32]);
    expect(linkCandidates(candidates, current.id, '999')).toEqual([]);
    expect(linkCandidates(candidates, current.id, '３')).toEqual([]);
  });

  it('keeps ties deterministic across official, provisional, creation and source order', () => {
    const repeatedId = fixtureCardId('candidate-repeated');
    const official = card('official', { kind: 'official', value: 30 }, 30);
    const provisionalOlder = card(
      'provisional-older',
      { kind: 'provisional', value: 30 },
      10,
    );
    const provisionalStableFirst = {
      ...card(
        'provisional-stable-first',
        { kind: 'provisional', value: 30 },
        20,
      ),
      id: repeatedId,
    };
    const provisionalStableSecond = {
      ...card(
        'provisional-stable-second',
        { kind: 'provisional', value: 30 },
        20,
      ),
      id: repeatedId,
    };
    const current = card('tie-current', { kind: 'official', value: 44 }, 44);

    expect(
      linkCandidates(
        [
          provisionalStableFirst,
          current,
          provisionalStableSecond,
          provisionalOlder,
          official,
        ],
        current.id,
        '3',
      ).map((item) => item.title),
    ).toEqual([
      'official',
      'provisional-older',
      'provisional-stable-first',
      'provisional-stable-second',
    ]);
  });
});
