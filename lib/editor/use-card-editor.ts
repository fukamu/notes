'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import { type Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type {
  CardEditorCandidateModel,
  CardEditorInputModel,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import type { CardId } from '@/lib/domain/id';
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';
import {
  classifyCardEditorDocumentUpdate,
  cardEditorHistoryShortcut,
  cardEditorCandidateToken,
  clampCardEditorCandidate,
  closeCardEditorCandidates,
  handleCardEditorCandidateKey,
  isCardEditorDeletionInput,
  isTypedCardEditorInput,
  openCardEditorCandidates,
  type CardEditorCandidateState,
} from '@/lib/editor/card-editor-state';
import {
  CardEditorTitleAttribute,
  CardEditorUndoRedo,
  cardEditorDocumentTitle,
  closeCardEditorHistory,
  createCardTitleHistoryTransaction,
} from '@/lib/editor/card-editor-history';
import { createCardLabelResolver } from '@/lib/editor/card-labels';
import { createCardLinkExtension } from '@/lib/editor/card-link-extension';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';

export type CardEditorModel = {
  editor: Editor | null;
  title: string;
  ready: boolean;
  focused: boolean;
  selectionEmpty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  candidates: readonly CardEditorCandidateModel[];
  suggestionOpen: boolean;
  activeCandidate: number;
};

export type CardEditorCommands = {
  setTitleInputElement: (element: HTMLInputElement | null) => void;
  updateTitle: (title: string) => void;
  handleTitleBlur: () => void;
  handleTitleKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  handleTitleCompositionStart: () => void;
  handleTitleCompositionEnd: () => void;
  prepareBodyEditing: () => void;
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
  'openCard' | 'updateTitle' | 'updateBody'
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
    undoRedo: false,
  });
}

type PendingCardTitle = Readonly<{
  cardId: CardId;
  before: string;
  after: string;
}>;

function bodyKey(body: CardEditorInputModel['body']): string {
  return JSON.stringify(body);
}

function editorBodyKey(editor: Editor): string {
  return bodyKey(editorDocumentToSegments(editor.getJSON()));
}

function titleFromEditor(editor: Editor): string | null {
  return cardEditorDocumentTitle(editor.state.doc.attrs);
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
  const [title, setTitle] = useState(input.title);
  const [pendingTitleAvailability, setPendingTitleAvailability] = useState({
    active: false,
    changed: false,
  });
  const [historyCanUndo, setHistoryCanUndo] = useState(false);
  const [historyCanRedo, setHistoryCanRedo] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [candidateState, setCandidateState] =
    useState<CardEditorCandidateState>(closeCardEditorCandidates);
  const triggerPositionRef = useRef<number | undefined>(undefined);
  const compositionInputRef = useRef(false);
  const titleCompositionRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const pendingTitleRef = useRef<PendingCardTitle | null>(null);
  const persistedTitleRef = useRef(input.title);
  const persistedBodyKeyRef = useRef(bodyKey(input.body));
  const inputRef = useRef(input);
  const actionsRef = useRef(actions);
  const mountedRef = useRef(true);
  const setTitleInputElement = useCallback(
    (element: HTMLInputElement | null) => {
      titleInputRef.current = element;
    },
    [],
  );
  const candidates = queryCardEditorCandidates(
    input.candidateIndex,
    candidateState.numberPrefix,
  );
  const normalizedCandidateState = clampCardEditorCandidate(
    candidateState,
    candidates.length,
  );
  const extensions = useMemo(
    () => [
      cardEditorStarterKit(),
      CardEditorTitleAttribute,
      CardEditorUndoRedo,
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

  useEffect(() => {
    inputRef.current = input;
    actionsRef.current = actions;
  }, [actions, input]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => () => labels.destroy(), [labels]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      content: segmentsToEditorDocument(input.body, input.title),
      editorProps: {
        attributes: presentation.contentAttributes,
        transformPastedHTML: sanitizePastedCardEditorHtml,
      },
      onCreate: ({ editor: currentEditor }) => {
        triggerPositionRef.current = undefined;
        compositionInputRef.current = false;
        setCandidateState(closeCardEditorCandidates());
        setEditorCardId(input.cardId);
        const createdTitle = titleFromEditor(currentEditor) ?? input.title;
        setTitle(createdTitle);
        persistedTitleRef.current = input.title;
        persistedBodyKeyRef.current = bodyKey(input.body);
        pendingTitleRef.current = null;
        setPendingTitleAvailability({ active: false, changed: false });
        setHistoryCanUndo(currentEditor.can().undo());
        setHistoryCanRedo(currentEditor.can().redo());
        setFocused(false);
        setSelectionEmpty(currentEditor.state.selection.empty);
      },
      onDestroy: () => {
        setEditorCardId((current) =>
          current === input.cardId ? null : current,
        );
      },
      onUpdate: ({ editor: currentEditor }) => {
        const nextTitle = titleFromEditor(currentEditor);
        if (nextTitle !== null) {
          setTitle(nextTitle);
          if (nextTitle !== persistedTitleRef.current) {
            persistedTitleRef.current = nextTitle;
            actionsRef.current.updateTitle(nextTitle);
          }
        }
        const nextBody = editorDocumentToSegments(currentEditor.getJSON());
        const nextBodyKey = bodyKey(nextBody);
        if (nextBodyKey !== persistedBodyKeyRef.current) {
          persistedBodyKeyRef.current = nextBodyKey;
          actionsRef.current.updateBody(nextBody);
        }
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
        setHistoryCanUndo(currentEditor.can().undo());
        setHistoryCanRedo(currentEditor.can().redo());
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
    const editorBodyMatches = editorBodyKey(editor) === bodyKey(input.body);
    const update = classifyCardEditorDocumentUpdate(
      editorCardId,
      input.cardId,
      editorBodyMatches,
    );
    if (update === 'identity-reset') {
      pendingTitleRef.current = null;
      titleCompositionRef.current = false;
      persistedTitleRef.current = input.title;
      persistedBodyKeyRef.current = bodyKey(input.body);
      return;
    }

    const pendingTitle = pendingTitleRef.current;
    const titleIsSelfEcho =
      input.title === persistedTitleRef.current ||
      (pendingTitle?.cardId === input.cardId &&
        input.title === pendingTitle.after);
    const bodyIsSelfEcho = bodyKey(input.body) === persistedBodyKeyRef.current;
    if (titleIsSelfEcho && bodyIsSelfEcho) return;

    const nextDocument = editor.schema.nodeFromJSON(
      segmentsToEditorDocument(input.body, input.title),
    );
    editor.view.updateState(
      EditorState.create({
        schema: editor.schema,
        doc: nextDocument,
        plugins: editor.state.plugins,
      }),
    );
    pendingTitleRef.current = null;
    titleCompositionRef.current = false;
    persistedTitleRef.current = input.title;
    persistedBodyKeyRef.current = bodyKey(input.body);
    triggerPositionRef.current = undefined;
    const synchronizedCardId = input.cardId;
    queueMicrotask(() => {
      if (
        !mountedRef.current ||
        inputRef.current.cardId !== synchronizedCardId
      ) {
        return;
      }
      setTitle(input.title);
      setPendingTitleAvailability({ active: false, changed: false });
      setHistoryCanUndo(false);
      setHistoryCanRedo(false);
      setCandidateState(closeCardEditorCandidates());
      setSelectionEmpty(editor.state.selection.empty);
    });
  }, [editor, editorCardId, input.body, input.cardId, input.title]);

  const updateHistoryAvailability = (currentEditor: Editor) => {
    setHistoryCanUndo(currentEditor.can().undo());
    setHistoryCanRedo(currentEditor.can().redo());
  };

  const commitPendingTitle = (currentEditor: Editor): boolean => {
    const pending = pendingTitleRef.current;
    if (
      !pending ||
      pending.cardId !== inputRef.current.cardId ||
      currentEditor.isDestroyed
    ) {
      return false;
    }
    pendingTitleRef.current = null;
    setPendingTitleAvailability({ active: false, changed: false });
    if (pending.before === pending.after) {
      updateHistoryAvailability(currentEditor);
      return false;
    }
    const transaction = createCardTitleHistoryTransaction(
      currentEditor.state,
      pending.after,
    );
    if (!transaction) {
      updateHistoryAvailability(currentEditor);
      return false;
    }
    currentEditor.view.dispatch(transaction);
    currentEditor.view.dispatch(closeCardEditorHistory(currentEditor.state.tr));
    updateHistoryAvailability(currentEditor);
    return true;
  };

  const focusHistoryTarget = (
    currentEditor: Editor,
    titleChanged: boolean,
    bodyChanged: boolean,
  ) => {
    queueMicrotask(() => {
      if (
        !mountedRef.current ||
        currentEditor.isDestroyed ||
        editorCardId !== inputRef.current.cardId
      ) {
        return;
      }
      if (titleChanged) {
        const titleInput = titleInputRef.current;
        if (!titleInput) return;
        titleInput.focus({ preventScroll: true });
        const end = titleInput.value.length;
        titleInput.setSelectionRange(end, end);
        return;
      }
      if (bodyChanged) currentEditor.commands.focus();
    });
  };

  const runHistoryCommand = (direction: 'undo' | 'redo') => {
    if (!editor || editor.isDestroyed || editorCardId !== input.cardId) return;
    commitPendingTitle(editor);
    const beforeTitle = titleFromEditor(editor);
    const beforeBody = editorBodyKey(editor);
    const applied =
      direction === 'undo' ? editor.commands.undo() : editor.commands.redo();
    if (!applied) {
      updateHistoryAvailability(editor);
      return;
    }
    const afterTitle = titleFromEditor(editor);
    const afterBody = editorBodyKey(editor);
    focusHistoryTarget(
      editor,
      beforeTitle !== afterTitle,
      beforeBody !== afterBody,
    );
  };

  const historyShortcutFor = (
    event:
      | ReactKeyboardEvent<HTMLInputElement>
      | ReactKeyboardEvent<HTMLDivElement>,
  ) =>
    cardEditorHistoryShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      composing: event.nativeEvent.isComposing || titleCompositionRef.current,
    });

  const updateTitle = (nextTitle: string) => {
    if (nextTitle === title) return;
    if (editor && !editor.isDestroyed && editorCardId === input.cardId) {
      const currentPending = pendingTitleRef.current;
      if (currentPending?.cardId === input.cardId) {
        const nextPending = {
          ...currentPending,
          after: nextTitle,
        };
        pendingTitleRef.current = nextPending;
        setPendingTitleAvailability({
          active: true,
          changed: nextPending.before !== nextPending.after,
        });
      } else {
        const before = titleFromEditor(editor);
        if (before !== null) {
          editor.view.dispatch(closeCardEditorHistory(editor.state.tr));
          pendingTitleRef.current = {
            cardId: input.cardId,
            before,
            after: nextTitle,
          };
          setPendingTitleAvailability({
            active: true,
            changed: before !== nextTitle,
          });
        }
      }
    }
    setTitle(nextTitle);
    if (nextTitle !== persistedTitleRef.current) {
      persistedTitleRef.current = nextTitle;
      actionsRef.current.updateTitle(nextTitle);
    }
  };

  const handleTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const shortcut = historyShortcutFor(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    runHistoryCommand(shortcut);
  };

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
    commitPendingTitle(editor);
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
    editor.view.dispatch(closeCardEditorHistory(editor.state.tr));
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({ type: 'cardLink', attrs: { targetCardId: cardId } })
      .run();
    editor.view.dispatch(closeCardEditorHistory(editor.state.tr));
    closeSuggestions();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editor) return;
    const shortcut = historyShortcutFor(event);
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();
      runHistoryCommand(shortcut);
      return;
    }
    if (event.nativeEvent.isComposing) return;
    commitPendingTitle(editor);
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
    if (editor) commitPendingTitle(editor);
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
      title: editorCardId === input.cardId ? title : input.title,
      ready:
        editor !== null && !editor.isDestroyed && editorCardId === input.cardId,
      focused,
      selectionEmpty,
      canUndo: pendingTitleAvailability.changed || historyCanUndo,
      canRedo: pendingTitleAvailability.active ? false : historyCanRedo,
      candidates,
      suggestionOpen: normalizedCandidateState.open,
      activeCandidate: normalizedCandidateState.activeIndex,
    },
    commands: {
      setTitleInputElement,
      updateTitle,
      handleTitleBlur: () => {
        if (editor && !titleCompositionRef.current) commitPendingTitle(editor);
      },
      handleTitleKeyDown,
      handleTitleCompositionStart: () => {
        titleCompositionRef.current = true;
      },
      handleTitleCompositionEnd: () => {
        titleCompositionRef.current = false;
      },
      prepareBodyEditing: () => {
        if (editor) commitPendingTitle(editor);
      },
      handleKeyDown,
      handleInput,
      handleCompositionEnd,
      preserveEditorFocus: (event) => event.preventDefault(),
      selectCandidate,
      undo: () => runHistoryCommand('undo'),
      redo: () => runHistoryCommand('redo'),
    },
  };
}
