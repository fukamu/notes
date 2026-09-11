'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from 'react';
import { type Editor } from '@tiptap/core';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import type {
  CardEditorCandidateModel,
  CardEditorInputModel,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import type { CardId } from '@/lib/domain/id';
import {
  classifyCardEditorDocumentUpdate,
  clampCardEditorCandidate,
  closeCardEditorCandidates,
  handleCardEditorCandidateKey,
  isCardEditorHashContext,
  isTypedCardEditorInput,
  openCardEditorCandidates,
  type CardEditorCandidateState,
} from '@/lib/editor/card-editor-state';
import { createCardLabelResolver } from '@/lib/editor/card-labels';
import { createCardLinkExtension } from '@/lib/editor/card-link-extension';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';

export type CardEditorModel = {
  editor: Editor | null;
  ready: boolean;
  focused: boolean;
  selectionEmpty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  candidates: CardEditorCandidateModel[];
  suggestionOpen: boolean;
  activeCandidate: number;
};

export type CardEditorCommands = {
  handleKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  handleInput: (event: SyntheticEvent<HTMLDivElement, InputEvent>) => void;
  handleCompositionEnd: (event: ReactCompositionEvent<HTMLDivElement>) => void;
  preserveEditorFocus: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  selectCandidate: (cardId: CardId) => void;
  undo: () => void;
  redo: () => void;
};

export type CardEditorPresentationAdapter = {
  contentAttributes: Record<string, string>;
  cardLinkNodeView: { className: string };
};

type CardEditorActions = Pick<
  NotesPresentationActions,
  'openCard' | 'updateBody'
>;

type UseCardEditorOptions = {
  input: CardEditorInputModel;
  actions: CardEditorActions;
  presentation: CardEditorPresentationAdapter;
};

export function sanitizePastedCardEditorHtml(html: string): string {
  return html.replace(/<(?!\/?(?:p|br|span)(?:\s|>|\/))[^>]+>/gi, '');
}

function cardEditorStarterKit() {
  return StarterKit.configure({
    blockquote: false,
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    link: false,
    listItem: false,
    listKeymap: false,
    orderedList: false,
    strike: false,
    trailingNode: false,
    underline: false,
  });
}

export function useCardEditor({
  input,
  actions,
  presentation,
}: UseCardEditorOptions): {
  model: CardEditorModel;
  commands: CardEditorCommands;
} {
  const [labels] = useState(() => createCardLabelResolver(input.labels));
  const [editorCardId, setEditorCardId] = useState<CardId | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [candidateState, setCandidateState] =
    useState<CardEditorCandidateState>(closeCardEditorCandidates);
  const triggerPositionRef = useRef<number | undefined>(undefined);
  const compositionInputRef = useRef(false);
  const candidates: CardEditorCandidateModel[] = input.candidates;
  const normalizedCandidateState = clampCardEditorCandidate(
    candidateState,
    candidates.length,
  );
  const extensions = useMemo(
    () => [
      cardEditorStarterKit(),
      createCardLinkExtension({
        labels,
        nodeView: presentation.cardLinkNodeView,
        openCard: actions.openCard,
      }),
    ],
    [actions.openCard, labels, presentation.cardLinkNodeView],
  );

  useEffect(() => {
    labels.replaceLabels(input.labels);
  }, [input.labels, labels]);

  useEffect(() => () => labels.destroy(), [labels]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      content: segmentsToEditorDocument(input.body),
      editorProps: {
        attributes: presentation.contentAttributes,
        transformPastedHTML: sanitizePastedCardEditorHtml,
      },
      onCreate: ({ editor: currentEditor }) => {
        triggerPositionRef.current = undefined;
        compositionInputRef.current = false;
        setCandidateState(closeCardEditorCandidates());
        setEditorCardId(input.cardId);
        setCanUndo(currentEditor.can().undo());
        setCanRedo(currentEditor.can().redo());
        setFocused(false);
        setSelectionEmpty(currentEditor.state.selection.empty);
      },
      onDestroy: () => {
        setEditorCardId((current) =>
          current === input.cardId ? null : current,
        );
      },
      onUpdate: ({ editor: currentEditor }) => {
        actions.updateBody(editorDocumentToSegments(currentEditor.getJSON()));
      },
      onTransaction: ({ editor: currentEditor }) => {
        setCanUndo(currentEditor.can().undo());
        setCanRedo(currentEditor.can().redo());
      },
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onSelectionUpdate: ({ editor: currentEditor }) =>
        setSelectionEmpty(currentEditor.state.selection.empty),
    },
    [input.cardId],
  );

  useEffect(() => {
    if (!editor) return;
    const editorBody = editorDocumentToSegments(editor.getJSON());
    const update = classifyCardEditorDocumentUpdate(
      editorCardId,
      input.cardId,
      JSON.stringify(editorBody) === JSON.stringify(input.body),
    );
    if (update !== 'external-body-sync') return;
    editor.commands.setContent(segmentsToEditorDocument(input.body), {
      emitUpdate: false,
    });
  }, [editor, editorCardId, input.body, input.cardId]);

  const closeSuggestions = () => {
    setCandidateState(closeCardEditorCandidates());
    triggerPositionRef.current = undefined;
  };

  const openSuggestionsForInsertedHash = () => {
    if (!editor || editorCardId !== input.cardId) return;
    const { selection, doc } = editor.state;
    const to = selection.from;
    const textBeforeCursor = doc.textBetween(1, to, '\n');
    if (!isCardEditorHashContext(textBeforeCursor, selection.empty)) return;
    triggerPositionRef.current = to - 1;
    setCandidateState(openCardEditorCandidates());
  };

  const closeSuggestionsIfTriggerChanged = () => {
    if (!editor || triggerPositionRef.current === undefined) return;
    const { selection, doc } = editor.state;
    if (
      !selection.empty ||
      doc.textBetween(triggerPositionRef.current, selection.from, '\n') !== '#'
    ) {
      closeSuggestions();
    }
  };

  const selectCandidate = (cardId: CardId) => {
    if (!editor || editorCardId !== input.cardId) return;
    if (!candidates.some((candidate) => candidate.cardId === cardId)) return;
    const from = triggerPositionRef.current;
    if (from === undefined) return;
    const to = editor.state.selection.from;
    if (editor.state.doc.textBetween(from, to, '\n') !== '#') {
      closeSuggestions();
      return;
    }
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({ type: 'cardLink', attrs: { targetCardId: cardId } })
      .run();
    editor.view.dispatch(closeHistory(editor.state.tr));
    closeSuggestions();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editor || event.nativeEvent.isComposing) return;
    const result = handleCardEditorCandidateKey(
      normalizedCandidateState,
      event.key,
      candidates.length,
    );
    if (result.preventDefault) event.preventDefault();
    setCandidateState(result.state);
    if (result.command.type === 'select') {
      const candidate = candidates[result.command.index];
      if (candidate) selectCandidate(candidate.cardId);
    } else if (result.command.type === 'close') {
      triggerPositionRef.current = undefined;
    }
  };

  const handleInput = (event: SyntheticEvent<HTMLDivElement, InputEvent>) => {
    const inputEvent = event.nativeEvent;
    const insertsText =
      inputEvent.inputType === 'insertText' ||
      inputEvent.inputType === 'insertCompositionText';
    if (insertsText && inputEvent.isComposing) {
      compositionInputRef.current = true;
      return;
    }
    if (isTypedCardEditorInput(inputEvent.inputType, inputEvent.isComposing)) {
      queueMicrotask(() => {
        openSuggestionsForInsertedHash();
        closeSuggestionsIfTriggerChanged();
      });
      return;
    }
    queueMicrotask(closeSuggestionsIfTriggerChanged);
  };

  const handleCompositionEnd = (
    event: ReactCompositionEvent<HTMLDivElement>,
  ) => {
    const hadCompositionInput =
      compositionInputRef.current || event.data.length > 0;
    compositionInputRef.current = false;
    if (!hadCompositionInput) return;
    queueMicrotask(() => {
      openSuggestionsForInsertedHash();
      closeSuggestionsIfTriggerChanged();
    });
  };

  return {
    model: {
      editor,
      ready: editor !== null && editorCardId === input.cardId,
      focused,
      selectionEmpty,
      canUndo,
      canRedo,
      candidates,
      suggestionOpen: normalizedCandidateState.open,
      activeCandidate: normalizedCandidateState.activeIndex,
    },
    commands: {
      handleKeyDown,
      handleInput,
      handleCompositionEnd,
      preserveEditorFocus: (event) => event.preventDefault(),
      selectCandidate,
      undo: () => {
        editor?.chain().focus().undo().run();
      },
      redo: () => {
        editor?.chain().focus().redo().run();
      },
    },
  };
}
