import { describe, expect, it } from 'vitest';
import {
  cardEditorCandidateToken,
  cardEditorHistoryShortcut,
  filterCardEditorCandidates,
  handleCardEditorCandidateKey,
  isCardEditorDeletionInput,
  isCardEditorHashContext,
  isTypedCardEditorInput,
  openCardEditorCandidates,
} from '@/lib/editor/card-editor-state';

describe('card editor candidate state', () => {
  it('wraps ArrowUp/ArrowDown and selects the active candidate with Enter', () => {
    const open = openCardEditorCandidates();
    const up = handleCardEditorCandidateKey(open, 'ArrowUp', 3);
    expect(up).toMatchObject({
      state: { open: true, activeIndex: 2 },
      command: { type: 'none' },
      preventDefault: true,
    });
    const down = handleCardEditorCandidateKey(up.state, 'ArrowDown', 3);
    expect(down.state.activeIndex).toBe(0);
    expect(handleCardEditorCandidateKey(up.state, 'Enter', 3)).toEqual({
      state: { open: false, activeIndex: 0, numberPrefix: '' },
      command: { type: 'select', index: 2 },
      preventDefault: true,
    });
  });

  it('closes on Escape or content-changing keys without swallowing text', () => {
    const open = openCardEditorCandidates();
    expect(handleCardEditorCandidateKey(open, 'Escape', 2)).toMatchObject({
      state: { open: false },
      command: { type: 'close' },
      preventDefault: true,
    });
    expect(handleCardEditorCandidateKey(open, '1', 2)).toMatchObject({
      state: { open: true },
      command: { type: 'none' },
      preventDefault: false,
    });
    expect(handleCardEditorCandidateKey(open, '。', 2)).toMatchObject({
      state: { open: false },
      command: { type: 'close' },
      preventDefault: false,
    });
    expect(handleCardEditorCandidateKey(open, 'Backspace', 2)).toMatchObject({
      state: { open: true },
      command: { type: 'none' },
      preventDefault: false,
    });
  });
});

describe('card editor input and IME classification', () => {
  it('routes platform history shortcuts once and leaves composition alone', () => {
    const key = (
      overrides: Partial<Parameters<typeof cardEditorHistoryShortcut>[0]>,
    ) =>
      cardEditorHistoryShortcut({
        key: 'z',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        composing: false,
        ...overrides,
      });

    expect(key({})).toBe('undo');
    expect(key({ shiftKey: true })).toBe('redo');
    expect(key({ key: 'y' })).toBe('redo');
    expect(key({ key: 'я' })).toBe('undo');
    expect(key({ composing: true })).toBeNull();
    expect(key({ altKey: true })).toBeNull();
    expect(key({ ctrlKey: true, metaKey: true })).toBeNull();
    expect(key({ ctrlKey: false, metaKey: false })).toBeNull();
  });

  it('inspects direct text and completed composition, but not active composition or paste', () => {
    expect(isTypedCardEditorInput('insertText', false)).toBe(true);
    expect(isTypedCardEditorInput('insertCompositionText', false)).toBe(true);
    expect(isTypedCardEditorInput('insertCompositionText', true)).toBe(false);
    expect(isTypedCardEditorInput('insertFromPaste', false)).toBe(false);
  });

  it.each([
    'deleteContentBackward',
    'deleteContentForward',
    'deleteWordBackward',
    'deleteByCut',
    'deleteByDrag',
  ])('recognizes %s as a candidate-query deletion', (inputType) => {
    expect(isCardEditorDeletionInput(inputType)).toBe(true);
  });

  it.each(['insertText', 'insertFromPaste', 'historyUndo'])(
    'does not classify %s as deletion',
    (inputType) => {
      expect(isCardEditorDeletionInput(inputType)).toBe(false);
    },
  );

  it.each([
    ['#', true, true],
    ['本文 #', true, true],
    ['C#', true, false],
    ['#123', true, true],
    ['＃', true, false],
    ['https://example.test/#', true, false],
    ['[md](#', true, false],
    ['#', false, false],
  ] as const)(
    'classifies hash context %j with selectionEmpty=%j',
    (text, selectionEmpty, expected) => {
      expect(isCardEditorHashContext(text, selectionEmpty)).toBe(expected);
    },
  );

  it('extracts only an allowed ASCII numeric prefix token', () => {
    expect(cardEditorCandidateToken('本文 #320', true)).toEqual({
      numberPrefix: '320',
      length: 4,
    });
    expect(cardEditorCandidateToken('本文 #３', true)).toBeNull();
    expect(
      cardEditorCandidateToken('https://example.test/#32', true),
    ).toBeNull();
    expect(cardEditorCandidateToken('#32', false)).toBeNull();
  });

  it('filters typed candidate models by display-number prefix without mutation', () => {
    const candidates = [
      { displayValue: 39, title: '39' },
      { displayValue: 32, title: '32' },
      { displayValue: 3, title: '3' },
      { displayValue: 2, title: '2' },
    ];
    expect(filterCardEditorCandidates(candidates, '3')).toEqual([
      candidates[0],
      candidates[1],
      candidates[2],
    ]);
    expect(filterCardEditorCandidates(candidates, '32')).toEqual([
      candidates[1],
    ]);
    expect(filterCardEditorCandidates(candidates, '３')).toEqual([]);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      '39',
      '32',
      '3',
      '2',
    ]);
  });

  it('derives every narrowing and re-expansion from the full candidate set', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      displayValue: 100 - index,
    }));
    const valuesFor = (numberPrefix: string) =>
      filterCardEditorCandidates(candidates, numberPrefix).map(
        (candidate) => candidate.displayValue,
      );

    expect(valuesFor('')).toHaveLength(100);
    expect(valuesFor('3')).toEqual([39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 3]);
    expect(valuesFor('36')).toEqual([36]);
    expect(valuesFor('3')).toEqual([39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 3]);
    expect(valuesFor('')).toHaveLength(100);
    expect(candidates).toHaveLength(100);
  });
});
