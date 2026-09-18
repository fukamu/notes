import { Extension } from '@tiptap/core';
import { closeHistory, history, redo, undo } from '@tiptap/pm/history';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export const CARD_EDITOR_TITLE_ATTRIBUTE = 'cardTitle';

function decodedTitleAttribute(attributes: unknown): string | null {
  if (typeof attributes !== 'object' || attributes === null) return null;
  const value: unknown = Reflect.get(attributes, CARD_EDITOR_TITLE_ATTRIBUTE);
  return typeof value === 'string' ? value : null;
}

export function cardEditorDocumentTitle(attributes: unknown): string | null {
  return decodedTitleAttribute(attributes);
}

export const CardEditorTitleAttribute = Extension.create({
  name: 'cardEditorTitleAttribute',

  addGlobalAttributes() {
    return [
      {
        types: ['doc'],
        attributes: {
          [CARD_EDITOR_TITLE_ATTRIBUTE]: { default: '' },
        },
      },
    ];
  },
});

/**
 * The stock command/plugin contract without its DOM key bindings. React owns
 * the title and body shortcuts so one key press cannot reach two histories.
 */
export const CardEditorUndoRedo = Extension.create({
  name: 'cardEditorUndoRedo',

  addCommands() {
    return {
      undo:
        () =>
        ({ state, dispatch }) =>
          undo(state, dispatch),
      redo:
        () =>
        ({ state, dispatch }) =>
          redo(state, dispatch),
    };
  },

  addProseMirrorPlugins() {
    return [history()];
  },
});

export function createCardTitleHistoryTransaction(
  state: EditorState,
  nextTitle: string,
): Transaction | null {
  const currentTitle = decodedTitleAttribute(state.doc.attrs);
  if (currentTitle === null || currentTitle === nextTitle) return null;
  return closeHistory(state.tr).setDocAttribute(
    CARD_EDITOR_TITLE_ATTRIBUTE,
    nextTitle,
  );
}

export function closeCardEditorHistory(transaction: Transaction): Transaction {
  return closeHistory(transaction);
}
