import { describe, expect, it } from 'vitest';
import {
  selectCardEditorInputModel,
  selectConflictViewModel,
  selectConflictViewModels,
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
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';
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

    const model = selectCardEditorInputModel(
      [current, provisional, earlier],
      current,
    );

    expect(model).toMatchObject({
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
    });
    expect(queryCardEditorCandidates(model.candidateIndex, '')).toEqual([
      {
        cardId: provisional.id,
        displayLabel: '仮 #2',
        displayValue: 2,
        title: 'editor-provisional',
      },
      {
        cardId: earlier.id,
        displayLabel: '#1',
        displayValue: 1,
        title: 'Untitled',
      },
    ]);
  });
});

describe('history view model', () => {
  it.each([0, 1, 9, 10, 99, 100, 105])(
    'sorts %i display IDs by numeric value descending without mutation',
    (cardCount) => {
      const cards = Array.from({ length: cardCount }, (_, index) =>
        card(`history-${index + 1}`, {
          displayId: { kind: 'official', value: index + 1 },
        }),
      ).reverse();
      const inputOrder = cards.map((item) => item.id);

      const model = selectHistoryViewModel(cards, null);

      expect(model.items.map((item) => item.displayValue)).toEqual(
        Array.from({ length: cardCount }, (_, index) => cardCount - index),
      );
      expect(cards.map((item) => item.id)).toEqual(inputOrder);
    },
  );

  it('marks current and keeps deterministic stable ties below descending numbers', () => {
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
      'late-number',
      'official',
      'provisional',
      'stable-first',
      'stable-second',
    ]);
    expect(model.items.filter((item) => item.current)).toHaveLength(2);
    expect(model.items[2]?.displayLabel).toBe('仮 #2');
  });

  it('keeps created-at and card-id tie breaks ascending within one kind and number', () => {
    const firstId = fixtureCardId('history-tie-a');
    const secondId = fixtureCardId('history-tie-z');
    const earlierId = firstId.localeCompare(secondId) < 0 ? firstId : secondId;
    const laterId = earlierId === firstId ? secondId : firstId;
    const model = selectHistoryViewModel(
      [
        card('created-later', {
          id: earlierId,
          displayId: { kind: 'official', value: 7 },
          createdAt: 2,
        }),
        card('id-later', {
          id: laterId,
          displayId: { kind: 'official', value: 7 },
          createdAt: 1,
        }),
        card('id-earlier', {
          id: earlierId,
          displayId: { kind: 'official', value: 7 },
          createdAt: 1,
        }),
      ],
      null,
    );

    expect(model.items.map((item) => item.title)).toEqual([
      'id-earlier',
      'id-later',
      'created-later',
    ]);
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

  it('normalizes whitespace after resolving links without mutating cards', () => {
    const target = card('history-preview-target', {
      displayId: { kind: 'provisional', value: 8 },
      title: '',
    });
    const source = card('history-preview-source', {
      displayId: { kind: 'official', value: 9 },
      body: [
        { type: 'text', text: '  before\n\t' },
        { type: 'link', targetCardId: target.id },
        { type: 'text', text: '   after  ' },
      ],
    });
    const cards = [target, source];
    const snapshot = structuredClone(cards);

    const model = selectHistoryViewModel(cards, source.id);

    expect(model.items.find((item) => item.cardId === source.id)).toMatchObject(
      {
        preview: 'before ［仮 #8 Untitled］ after',
        current: true,
      },
    );
    expect(cards).toEqual(snapshot);
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
    expect(model.resolutionState).toBe('ready');
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

  it('projects multiple conflicts through the shared card lookup', () => {
    const existing = card('conflict-shared-target', {
      displayId: { kind: 'provisional', value: 6 },
      title: '',
    });
    const first: ConflictRecord = {
      id: fixtureConflictId('shared-first'),
      cardId: existing.id,
      serverRevision: 2,
      localTitle: 'First local',
      localBody: [{ type: 'link', targetCardId: existing.id }],
      serverTitle: 'First server',
      serverBody: [],
      createdAt: 2,
    };
    const second: ConflictRecord = {
      ...first,
      id: fixtureConflictId('shared-second'),
      localTitle: 'Second local',
      serverTitle: 'Second server',
      createdAt: 3,
    };

    const models = selectConflictViewModels([first, second], [existing]);

    expect(models).toHaveLength(2);
    expect(models[0]?.options[0]?.preview).toBe('［仮 #6 Untitled］');
    expect(models[1]?.options[0]?.preview).toBe('［仮 #6 Untitled］');
    expect(
      selectConflictViewModels([first], [existing], {
        resolvingCardIds: [existing.id],
        failed: false,
      })[0]?.resolutionState,
    ).toBe('pending');
    expect(
      selectConflictViewModels([first], [existing], {
        resolvingCardIds: [existing.id],
        failed: true,
      })[0]?.resolutionState,
    ).toBe('failed');
    expect(selectConflictViewModels([], [existing])).toEqual([]);
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
