import { describe, expect, it } from 'vitest';
import {
  selectConflictViewModel,
  selectHistoryViewModel,
  selectNotesStatus,
} from '@/lib/application/view-models';
import type { CardRecord, ConflictRecord } from '@/lib/domain/types';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';

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

describe('notes status view model', () => {
  it('applies save-before-sync priority and exposes retry semantics', () => {
    expect(selectNotesStatus('failed', 'syncing')).toEqual({
      kind: 'save-failed',
      label: '端末への保存に失敗',
      retryable: false,
    });
    expect(selectNotesStatus('saving', 'failed').kind).toBe('saving');
    expect(selectNotesStatus('saved', 'syncing').kind).toBe('syncing');
    expect(selectNotesStatus('saved', 'offline').label).toBe(
      'オフライン・端末に保存済み',
    );
    expect(selectNotesStatus('saved', 'failed')).toEqual({
      kind: 'sync-failed',
      label: '同期失敗・端末に保存済み',
      retryable: true,
    });
    expect(selectNotesStatus('saved', 'idle').kind).toBe('saved');
  });
});

describe('history view model', () => {
  it('sorts display IDs, marks current, and keeps deterministic stable ties', () => {
    const repeatedId = fixtureCardId('history-repeated');
    const cards = [
      card('late-number', {
        displayId: { kind: 'official', value: 4 },
      }),
      card('provisional', {
        displayId: { kind: 'provisional', value: 2 },
      }),
      card('official', {
        displayId: { kind: 'official', value: 2 },
      }),
      card('stable-first', { id: repeatedId, title: 'stable-first' }),
      card('stable-second', { id: repeatedId, title: 'stable-second' }),
    ];

    const model = selectHistoryViewModel(cards, repeatedId);
    expect(model.items.map((item) => item.title)).toEqual([
      'stable-first',
      'stable-second',
      'official',
      'provisional',
      'late-number',
    ]);
    expect(model.items.filter((item) => item.current)).toHaveLength(2);
    expect(model.items[3]?.displayLabel).toBe('仮 #2');
  });

  it('builds normalized previews with empty and missing-link fallbacks', () => {
    const missingTarget = fixtureCardId('missing-history-target');
    const model = selectHistoryViewModel(
      [
        card('empty', { title: '', body: [] }),
        card('missing-link', {
          body: [{ type: 'link', targetCardId: missingTarget }],
        }),
      ],
      null,
    );

    expect(model.items[0]).toMatchObject({
      title: 'Untitled',
      preview: '本文はまだありません',
    });
    expect(model.items[1]?.preview).toContain('［リンク先なし］');
  });
});

describe('conflict view model', () => {
  it('provides complete local/server choices and safe missing-link previews', () => {
    const existing = card('conflicted');
    const conflict: ConflictRecord = {
      id: fixtureConflictId('choice'),
      cardId: existing.id,
      serverRevision: 2,
      localTitle: '',
      localBody: [],
      serverTitle: 'Server title',
      serverBody: [
        {
          type: 'link',
          targetCardId: fixtureCardId('missing-conflict-target'),
        },
      ],
      createdAt: 2,
    };

    const model = selectConflictViewModel(conflict, [existing]);
    expect(model.options).toEqual([
      {
        choice: 'local',
        heading: '編集案 A',
        title: 'Untitled',
        preview: '本文なし',
        accessibleName: '編集案「Untitled」を使う',
      },
      {
        choice: 'server',
        heading: '編集案 B',
        title: 'Server title',
        preview: '［リンク先なし］',
        accessibleName: '編集案「Server title」を使う',
      },
    ]);
  });
});
