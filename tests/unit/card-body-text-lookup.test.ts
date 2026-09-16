import { describe, expect, it } from 'vitest';
import {
  bodyToPlainTextFromLookup,
  createCardBodyTextLookup,
} from '@/lib/application/card-body-text-lookup';
import { bodyToPlainText } from '@/lib/domain/body';
import type { BodySegment, CardRecord } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

function card(label: string, options: Partial<CardRecord> = {}): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: 1 },
    title: label,
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
    ...options,
  };
}

describe('card body text lookup', () => {
  it('matches legacy text, link, title, provisional and missing-link output', () => {
    const official = card('official-target', {
      displayId: { kind: 'official', value: 7 },
      title: '',
    });
    const provisional = card('provisional-target', {
      displayId: { kind: 'provisional', value: 12 },
      title: 'Provisional',
    });
    const missing = fixtureCardId('missing-text-target');
    const cards = [official, provisional];
    const body: BodySegment[] = [
      { type: 'text', text: 'before\n' },
      { type: 'link', targetCardId: official.id },
      { type: 'text', text: ' between ' },
      { type: 'link', targetCardId: provisional.id },
      { type: 'link', targetCardId: missing },
    ];
    const cardsSnapshot = structuredClone(cards);
    const bodySnapshot = structuredClone(body);
    const lookup = createCardBodyTextLookup(cards);

    expect(bodyToPlainTextFromLookup(body, lookup)).toBe(
      bodyToPlainText(body, cards),
    );
    expect(bodyToPlainTextFromLookup(body, lookup)).toBe(
      'before\n［#7 Untitled］ between ［仮 #12 Provisional］［リンク先なし］',
    );
    expect(cards).toEqual(cardsSnapshot);
    expect(body).toEqual(bodySnapshot);
  });

  it('preserves the legacy last-card-wins rule for duplicate CardIds', () => {
    const repeatedId = fixtureCardId('duplicate-text-target');
    const first = card('duplicate-first', {
      id: repeatedId,
      displayId: { kind: 'official', value: 2 },
      title: 'First',
    });
    const last = card('duplicate-last', {
      id: repeatedId,
      displayId: { kind: 'provisional', value: 9 },
      title: 'Last',
    });
    const body: BodySegment[] = [{ type: 'link', targetCardId: repeatedId }];
    const cards = [first, last];
    const lookup = createCardBodyTextLookup(cards);

    expect(lookup.size).toBe(1);
    expect(bodyToPlainTextFromLookup(body, lookup)).toBe(
      bodyToPlainText(body, cards),
    );
    expect(bodyToPlainTextFromLookup(body, lookup)).toBe('［仮 #9 Last］');
  });

  it('keeps empty input empty', () => {
    expect(bodyToPlainTextFromLookup([], createCardBodyTextLookup([]))).toBe(
      '',
    );
  });
});
