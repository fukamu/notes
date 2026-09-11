import type { CardId } from '@/lib/domain/id';

export type CardEditorCandidateState = {
  open: boolean;
  activeIndex: number;
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
};

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

export function openCardEditorCandidates(): CardEditorCandidateState {
  return { open: true, activeIndex: 0 };
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
  if (key.length === 1 || key === 'Backspace' || key === 'Delete') {
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
  if (!selectionEmpty || !textBeforeCursor.endsWith('#')) return false;
  const prefix = textBeforeCursor.slice(0, -1);
  const previous = prefix.at(-1) ?? '';
  if (previous && /[\p{L}\p{N}_]/u.test(previous)) return false;

  const token = prefix.split(/\s/u).at(-1) ?? '';
  if (token.includes('://') || token.includes('](')) return false;
  return true;
}
