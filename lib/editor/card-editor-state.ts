import type { CardId } from '@/lib/domain/id';

export type CardEditorCandidateState = {
  open: boolean;
  activeIndex: number;
  numberPrefix: string;
};

export type CardEditorCandidateCommand =
  | { type: 'none' }
  | { type: 'select'; index: number }
  | { type: 'close' };

export type CardEditorCandidateKeyResult = {
  state: CardEditorCandidateState;
  command: CardEditorCandidateCommand;
  preventDefault: boolean;
};

export const CLOSED_CARD_EDITOR_CANDIDATES: CardEditorCandidateState = {
  open: false,
  activeIndex: 0,
  numberPrefix: '',
};

export type CardEditorCandidateToken = Readonly<{
  numberPrefix: string;
  length: number;
}>;

export type CardEditorDocumentUpdate =
  | 'identity-reset'
  | 'external-body-sync'
  | 'unchanged';

export function classifyCardEditorDocumentUpdate(
  editorCardId: CardId | null,
  nextCardId: CardId,
  bodyMatches: boolean,
): CardEditorDocumentUpdate {
  if (editorCardId !== nextCardId) return 'identity-reset';
  return bodyMatches ? 'unchanged' : 'external-body-sync';
}

export function openCardEditorCandidates(
  numberPrefix = '',
): CardEditorCandidateState {
  return { open: true, activeIndex: 0, numberPrefix };
}

export function closeCardEditorCandidates(): CardEditorCandidateState {
  return CLOSED_CARD_EDITOR_CANDIDATES;
}

export function clampCardEditorCandidate(
  state: CardEditorCandidateState,
  candidateCount: number,
): CardEditorCandidateState {
  if (candidateCount <= 0 || state.activeIndex < candidateCount) return state;
  return { ...state, activeIndex: candidateCount - 1 };
}

export function handleCardEditorCandidateKey(
  state: CardEditorCandidateState,
  key: string,
  candidateCount: number,
): CardEditorCandidateKeyResult {
  if (!state.open) {
    return { state, command: { type: 'none' }, preventDefault: false };
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const direction = key === 'ArrowDown' ? 1 : -1;
    const activeIndex =
      candidateCount === 0
        ? 0
        : (state.activeIndex + direction + candidateCount) % candidateCount;
    return {
      state: { ...state, activeIndex },
      command: { type: 'none' },
      preventDefault: true,
    };
  }
  if (key === 'Enter' && candidateCount > 0) {
    return {
      state: CLOSED_CARD_EDITOR_CANDIDATES,
      command: { type: 'select', index: state.activeIndex },
      preventDefault: true,
    };
  }
  if (key === 'Escape') {
    return {
      state: CLOSED_CARD_EDITOR_CANDIDATES,
      command: { type: 'close' },
      preventDefault: true,
    };
  }
  if (/^[0-9]$/u.test(key) || key === 'Backspace' || key === 'Delete') {
    return { state, command: { type: 'none' }, preventDefault: false };
  }
  if (key.length === 1) {
    return {
      state: CLOSED_CARD_EDITOR_CANDIDATES,
      command: { type: 'close' },
      preventDefault: false,
    };
  }
  return { state, command: { type: 'none' }, preventDefault: false };
}

export function isTypedCardEditorInput(
  inputType: string,
  isComposing: boolean,
): boolean {
  return (
    !isComposing &&
    (inputType === 'insertText' || inputType === 'insertCompositionText')
  );
}

export function isCardEditorHashContext(
  textBeforeCursor: string,
  selectionEmpty: boolean,
): boolean {
  return cardEditorCandidateToken(textBeforeCursor, selectionEmpty) !== null;
}

export function cardEditorCandidateToken(
  textBeforeCursor: string,
  selectionEmpty: boolean,
): CardEditorCandidateToken | null {
  if (!selectionEmpty) return null;
  const match = textBeforeCursor.match(/#([0-9]*)$/u);
  if (!match) return null;
  const numberPrefix = match[1];
  if (numberPrefix === undefined) return null;
  const length = numberPrefix.length + 1;
  const prefix = textBeforeCursor.slice(0, -length);
  const previous = prefix.at(-1) ?? '';
  if (previous && /[\p{L}\p{N}_]/u.test(previous)) return null;

  const token = prefix.split(/\s/u).at(-1) ?? '';
  if (token.includes('://') || token.includes('](')) return null;
  return { numberPrefix, length };
}

export function filterCardEditorCandidates<
  Candidate extends Readonly<{ displayValue: number }>,
>(candidates: readonly Candidate[], numberPrefix: string): Candidate[] {
  if (!/^\d*$/u.test(numberPrefix)) return [];
  return candidates.filter((candidate) =>
    String(candidate.displayValue).startsWith(numberPrefix),
  );
}
