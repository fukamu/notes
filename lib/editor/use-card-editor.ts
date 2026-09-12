'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
  cardEditorCandidateToken,
  clampCardEditorCandidate,
  closeCardEditorCandidates,
  filterCardEditorCandidates,
  handleCardEditorCandidateKey,
  isCardEditorDeletionInput,
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
  preserveEditorFocus: (event: ReactPointerEvent<HTMLButtonElement>) => void;
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

function candidateTokenAtSelection(editor: Editor): {
  from: number;
  numberPrefix: string;
} | null {
  const { selection, doc } = editor.state;
  const to = selection.from;
  const token = cardEditorCandidateToken(
    doc.textBetween(1, to, '\n'),
    selection.empty,
  );
  return token
    ? { from: to - token.length, numberPrefix: token.numberPrefix }
    : null;
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
  const candidates: CardEditorCandidateModel[] = filterCardEditorCandidates(
    input.candidates,
    candidateState.numberPrefix,
  );
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
        const triggerPosition = triggerPositionRef.current;
        if (triggerPosition === undefined || currentEditor.view.composing)
          return;
        const token = candidateTokenAtSelection(currentEditor);
        if (!token || token.from !== triggerPosition) {
          setCandidateState(closeCardEditorCandidates());
          triggerPositionRef.current = undefined;
          return;
        }
        setCandidateState((current) =>
          current.open && current.numberPrefix === token.numberPrefix
            ? current
            : openCardEditorCandidates(token.numberPrefix),
        );
      },
      onTransaction: ({ editor: currentEditor }) => {
        if (currentEditor.isDestroyed) return;
        setCanUndo(currentEditor.can().undo());
        setCanRedo(currentEditor.can().redo());
      },
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        setCandidateState(closeCardEditorCandidates());
        triggerPositionRef.current = undefined;
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { selection } = currentEditor.state;
        setSelectionEmpty(selection.empty);
        const triggerPosition = triggerPositionRef.current;
        if (triggerPosition === undefined) return;
        const token = candidateTokenAtSelection(currentEditor);
        if (!token || token.from !== triggerPosition) {
          setCandidateState(closeCardEditorCandidates());
          triggerPositionRef.current = undefined;
        }
      },
    },
    [input.cardId],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
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

  const updateSuggestionsForCandidateToken = () => {
    if (!editor || editor.isDestroyed || editorCardId !== input.cardId) return;
    const token = candidateTokenAtSelection(editor);
    if (!token) {
      closeSuggestions();
      return;
    }
    triggerPositionRef.current = token.from;
    setCandidateState((current) =>
      current.open && current.numberPrefix === token.numberPrefix
        ? current
        : openCardEditorCandidates(token.numberPrefix),
    );
  };

  const closeSuggestionsIfTriggerChanged = () => {
    if (
      !editor ||
      editor.isDestroyed ||
      triggerPositionRef.current === undefined
    )
      return;
    const token = candidateTokenAtSelection(editor);
    if (!token || token.from !== triggerPositionRef.current) {
      closeSuggestions();
    }
  };

  const selectCandidate = (cardId: CardId) => {
    if (!editor || editor.isDestroyed || editorCardId !== input.cardId) return;
    if (!candidates.some((candidate) => candidate.cardId === cardId)) return;
    const from = triggerPositionRef.current;
    if (from === undefined) return;
    const to = editor.state.selection.from;
    if (
      editor.state.doc.textBetween(from, to, '\n') !==
      `#${normalizedCandidateState.numberPrefix}`
    ) {
      closeSuggestions();
      return;
    }
    editor.view.dispatch(closeHistory(editor.state.tr));
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
        updateSuggestionsForCandidateToken();
      });
      return;
    }
    if (isCardEditorDeletionInput(inputEvent.inputType)) {
      queueMicrotask(updateSuggestionsForCandidateToken);
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
      updateSuggestionsForCandidateToken();
    });
  };

  return {
    model: {
      editor,
      ready:
        editor !== null && !editor.isDestroyed && editorCardId === input.cardId,
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
        if (editor && !editor.isDestroyed) editor.chain().focus().undo().run();
      },
      redo: () => {
        if (editor && !editor.isDestroyed) editor.chain().focus().redo().run();
      },
    },
  };
}
