import { describe, expect, it } from 'vitest';
import {
  selectCardEditorInputModel,
  selectConflictViewModel,
  selectConnectionsViewModel,
  selectHistoryViewModel,
  selectNotesStatus,
} from '@/lib/application/view-models';
import type {
  CardRecord,
  ConflictRecord,
  SaveState,
  SyncState,
} from '@/lib/domain/types';
import type { NotesStatusViewModel } from '@/lib/application/presentation';
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
  const saveFailed: NotesStatusViewModel = {
    kind: 'save-failed',
    label: '端末への保存に失敗',
    retryable: false,
  };
  const saving: NotesStatusViewModel = {
    kind: 'saving',
    label: '保存中',
    retryable: false,
  };
  const cases = [
    { saveState: 'failed', syncState: 'idle', expected: saveFailed },
    { saveState: 'failed', syncState: 'syncing', expected: saveFailed },
    { saveState: 'failed', syncState: 'offline', expected: saveFailed },
    { saveState: 'failed', syncState: 'failed', expected: saveFailed },
    { saveState: 'saving', syncState: 'idle', expected: saving },
    { saveState: 'saving', syncState: 'syncing', expected: saving },
    { saveState: 'saving', syncState: 'offline', expected: saving },
    { saveState: 'saving', syncState: 'failed', expected: saving },
    {
      saveState: 'saved',
      syncState: 'idle',
      expected: { kind: 'saved', label: '保存済み', retryable: false },
    },
    {
      saveState: 'saved',
      syncState: 'syncing',
      expected: { kind: 'syncing', label: '同期中', retryable: false },
    },
    {
      saveState: 'saved',
      syncState: 'offline',
      expected: {
        kind: 'offline',
        label: 'オフライン・端末に保存済み',
        retryable: false,
      },
    },
    {
      saveState: 'saved',
      syncState: 'failed',
      expected: {
        kind: 'sync-failed',
        label: '同期失敗・端末に保存済み',
        retryable: true,
      },
    },
  ] satisfies ReadonlyArray<{
    saveState: SaveState;
    syncState: SyncState;
    expected: NotesStatusViewModel;
  }>;

  it.each(cases)(
    'maps $saveState/$syncState with save-before-sync priority',
    ({ saveState, syncState, expected }) => {
      expect(selectNotesStatus(saveState, syncState)).toEqual(expected);
    },
  );
});

describe('card editor input view model', () => {
  it('derives sorted candidates and instance label inputs without raw store access', () => {
    const current = card('editor-current', {
      displayId: { kind: 'official', value: 4 },
      body: [{ type: 'text', text: 'Current body' }],
    });
    const earlier = card('editor-earlier', {
      displayId: { kind: 'official', value: 1 },
      title: '',
    });
    const provisional = card('editor-provisional', {
      displayId: { kind: 'provisional', value: 2 },
    });

    expect(
      selectCardEditorInputModel([current, provisional, earlier], current),
    ).toEqual({
      cardId: current.id,
      body: current.body,
      labels: [
        { cardId: current.id, label: '#4 editor-current' },
        {
          cardId: provisional.id,
          label: '仮 #2 editor-provisional',
        },
        { cardId: earlier.id, label: '#1 Untitled' },
      ],
      candidates: [
        { cardId: earlier.id, displayLabel: '#1', title: 'Untitled' },
        {
          cardId: provisional.id,
          displayLabel: '仮 #2',
          title: 'editor-provisional',
        },
      ],
    });
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

describe('connections input view model', () => {
  it('exposes semantic nodes and directed edge labels without raw cards', () => {
    const target = card('target', {
      displayId: { kind: 'official', value: 1 },
      title: '',
    });
    const source = card('source', {
      displayId: { kind: 'provisional', value: 2 },
      body: [{ type: 'link', targetCardId: target.id }],
    });

    expect(selectConnectionsViewModel([source, target], source.id)).toEqual({
      currentCardId: source.id,
      nodes: [
        {
          cardId: target.id,
          displayLabel: '#1',
          title: 'Untitled',
          accessibleName: '#1 Untitled',
          current: false,
        },
        {
          cardId: source.id,
          displayLabel: '仮 #2',
          title: 'source',
          accessibleName: '仮 #2 source、現在のカード',
          current: true,
        },
      ],
      edges: [
        {
          sourceCardId: source.id,
          targetCardId: target.id,
          accessibleName: 'source から Untitled へのリンク',
        },
      ],
    });
  });
});
