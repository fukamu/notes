/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  CardEditorTitleAttribute,
  CardEditorUndoRedo,
  cardEditorDocumentTitle,
  closeCardEditorHistory,
  createCardTitleHistoryTransaction,
} from '@/lib/editor/card-editor-history';
import { segmentsToEditorDocument } from '@/lib/editor/body-document';

const editors: Editor[] = [];

function createEditor(title: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      CardEditorTitleAttribute,
      CardEditorUndoRedo,
    ],
    content: segmentsToEditorDocument([], title),
  });
  editors.push(editor);
  return editor;
}

function title(editor: Editor): string | null {
  return cardEditorDocumentTitle(editor.state.doc.attrs);
}

function commitTitle(editor: Editor, nextTitle: string): void {
  const transaction = createCardTitleHistoryTransaction(
    editor.state,
    nextTitle,
  );
  if (!transaction) return;
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeCardEditorHistory(editor.state.tr));
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe('card editor shared history', () => {
  it('undoes and redoes title, body, title in chronological order', () => {
    const editor = createEditor('A');

    commitTitle(editor, 'B');
    editor.commands.insertContent('body');
    commitTitle(editor, 'C');

    expect(title(editor)).toBe('C');
    expect(editor.getText()).toBe('body');

    expect(editor.commands.undo()).toBe(true);
    expect(title(editor)).toBe('B');
    expect(editor.getText()).toBe('body');

    expect(editor.commands.undo()).toBe(true);
    expect(title(editor)).toBe('B');
    expect(editor.getText()).toBe('');

    expect(editor.commands.undo()).toBe(true);
    expect(title(editor)).toBe('A');
    expect(editor.getText()).toBe('');

    expect(editor.commands.redo()).toBe(true);
    expect(title(editor)).toBe('B');
    expect(editor.getText()).toBe('');

    expect(editor.commands.redo()).toBe(true);
    expect(title(editor)).toBe('B');
    expect(editor.getText()).toBe('body');

    expect(editor.commands.redo()).toBe(true);
    expect(title(editor)).toBe('C');
    expect(editor.getText()).toBe('body');
  });

  it('drops redo when a new title history event follows undo', () => {
    const editor = createEditor('A');
    commitTitle(editor, 'B');
    expect(editor.commands.undo()).toBe(true);

    commitTitle(editor, 'C');

    expect(title(editor)).toBe('C');
    expect(editor.can().redo()).toBe(false);
  });
});
