'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from 'react';
import { type Editor } from '@tiptap/core';
import type { Fragment } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type {
  CardEditorActivity,
  CardEditorCandidateModel,
  CardEditorDocumentInput,
  EditorFocusIntent,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import type { CardId } from '@/lib/domain/id';
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';
import {
  cardEditorHistoryShortcut,
  cardEditorCandidateToken,
  clampCardEditorCandidate,
  closeCardEditorCandidates,
  handleCardEditorCandidateKey,
  isCardEditorDeletionInput,
  isTypedCardEditorInput,
  openCardEditorCandidates,
  shouldMoveCardEditorTitleToBody,
  type CardEditorCandidateState,
} from '@/lib/editor/card-editor-state';
import {
  CARD_EDITOR_TITLE_ATTRIBUTE,
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
  document: CardEditorDocumentInput;
  activity: CardEditorActivity;
  actions: CardEditorActions;
  presentation: CardEditorPresentationAdapter;
  focusIntent?: EditorFocusIntent | null;
  consumeFocusIntent?: (requestId: number) => void;
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

type EditorBodySnapshot = Readonly<{
  content: Fragment;
  body: CardEditorDocumentInput['body'];
  key: string;
}>;

function bodyKey(body: CardEditorDocumentInput['body']): string {
  return JSON.stringify(body);
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
  document: documentInput,
  activity,
  actions,
  presentation,
  focusIntent = null,
  consumeFocusIntent = () => undefined,
}: UseCardEditorOptions): {
  model: CardEditorModel;
  commands: CardEditorCommands;
} {
  const [labels] = useState(() =>
    createCardLabelResolver(activity.kind === 'active' ? activity.labels : []),
  );
  const [editorCardId, setEditorCardId] = useState<CardId | null>(null);
  const [title, setTitle] = useState(documentInput.title);
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
  const persistedTitleRef = useRef(documentInput.title);
  const inputBodyKey = useMemo(
    () => bodyKey(documentInput.body),
    [documentInput.body],
  );
  const observedTitleRef = useRef(documentInput.title);
  const observedBodyKeyRef = useRef(inputBodyKey);
  const persistedBodyKeyRef = useRef(inputBodyKey);
  const bodySnapshotRef = useRef<EditorBodySnapshot | null>(null);
  const documentRef = useRef(documentInput);
  const activityRef = useRef(activity);
  const actionsRef = useRef(actions);
  const mountedRef = useRef(true);
  const focusIntentRef = useRef(focusIntent);
  const consumeFocusIntentRef = useRef(consumeFocusIntent);
  const editorInstanceRef = useRef<Editor | null>(null);
  const editorCardIdRef = useRef<CardId | null>(null);
  const scheduledTitleFocusRequestIdRef = useRef<number | null>(null);
  const completedTitleFocusRequestIdRef = useRef<number | null>(null);
  const requestTitleFocus = useCallback((element: HTMLInputElement | null) => {
    const requested = focusIntentRef.current;
    if (
      !element ||
      !requested ||
      scheduledTitleFocusRequestIdRef.current === requested.requestId ||
      completedTitleFocusRequestIdRef.current === requested.requestId
    ) {
      return;
    }
    scheduledTitleFocusRequestIdRef.current = requested.requestId;
    queueMicrotask(() => {
      if (scheduledTitleFocusRequestIdRef.current === requested.requestId) {
        scheduledTitleFocusRequestIdRef.current = null;
      }
      const currentIntent = focusIntentRef.current;
      const currentEditor = editorInstanceRef.current;
      if (
        !mountedRef.current ||
        titleInputRef.current !== element ||
        !currentIntent ||
        currentIntent.requestId !== requested.requestId ||
        currentIntent.cardId !== documentRef.current.cardId ||
        currentIntent.target !== 'title' ||
        activityRef.current.kind !== 'active' ||
        editorCardIdRef.current !== currentIntent.cardId ||
        !currentEditor ||
        currentEditor.isDestroyed
      ) {
        return;
      }
      element.focus({ preventScroll: true });
      if (element.ownerDocument.activeElement === element) {
        completedTitleFocusRequestIdRef.current = currentIntent.requestId;
        consumeFocusIntentRef.current(currentIntent.requestId);
      }
    });
  }, []);
  const setTitleInputElement = useCallback(
    (element: HTMLInputElement | null) => {
      titleInputRef.current = element;
      requestTitleFocus(element);
    },
    [requestTitleFocus],
  );
  const candidates =
    activity.kind === 'active'
      ? queryCardEditorCandidates(
          activity.candidateIndex,
          candidateState.numberPrefix,
        )
      : [];
  const normalizedCandidateState = clampCardEditorCandidate(
    candidateState,
    candidates.length,
  );
  const inputBodyDocument = useMemo(
    () => segmentsToEditorDocument(documentInput.body),
    [documentInput.body],
  );
  const inputDocument = useMemo(
    () => ({
      ...inputBodyDocument,
      attrs: {
        ...inputBodyDocument.attrs,
        [CARD_EDITOR_TITLE_ATTRIBUTE]: documentInput.title,
      },
    }),
    [documentInput.title, inputBodyDocument],
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
    if (activity.kind === 'active') labels.replaceLabels(activity.labels);
  }, [activity, labels]);

  useLayoutEffect(() => {
    documentRef.current = documentInput;
    activityRef.current = activity;
    actionsRef.current = actions;
    focusIntentRef.current = focusIntent;
    consumeFocusIntentRef.current = consumeFocusIntent;
  }, [actions, activity, consumeFocusIntent, documentInput, focusIntent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => () => labels.destroy(), [labels]);

  const readEditorBody = useCallback((currentEditor: Editor) => {
    const content = currentEditor.state.doc.content;
    const cached = bodySnapshotRef.current;
    if (cached?.content === content) return cached;

    const body = editorDocumentToSegments(currentEditor.getJSON());
    const snapshot = { content, body, key: bodyKey(body) };
    bodySnapshotRef.current = snapshot;
    return snapshot;
  }, []);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      content: inputDocument,
      editorProps: {
        attributes: presentation.contentAttributes,
        transformPastedHTML: sanitizePastedCardEditorHtml,
      },
      onCreate: ({ editor: currentEditor }) => {
        triggerPositionRef.current = undefined;
        compositionInputRef.current = false;
        bodySnapshotRef.current = null;
        setCandidateState(closeCardEditorCandidates());
        setEditorCardId(documentInput.cardId);
        const createdTitle =
          titleFromEditor(currentEditor) ?? documentInput.title;
        setTitle(createdTitle);
        persistedTitleRef.current = documentInput.title;
        observedTitleRef.current = documentInput.title;
        observedBodyKeyRef.current = inputBodyKey;
        persistedBodyKeyRef.current = inputBodyKey;
        pendingTitleRef.current = null;
        setPendingTitleAvailability({ active: false, changed: false });
        setHistoryCanUndo(currentEditor.can().undo());
        setHistoryCanRedo(currentEditor.can().redo());
        setFocused(false);
        setSelectionEmpty(currentEditor.state.selection.empty);
      },
      onDestroy: () => {
        bodySnapshotRef.current = null;
        setEditorCardId((current) =>
          current === documentInput.cardId ? null : current,
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
        const nextBody = readEditorBody(currentEditor);
        if (nextBody.key !== persistedBodyKeyRef.current) {
          persistedBodyKeyRef.current = nextBody.key;
          actionsRef.current.updateBody(nextBody.body);
        }
        if (activityRef.current.kind !== 'active') return;
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
      onFocus: () => {
        if (activityRef.current.kind === 'active') setFocused(true);
      },
      onBlur: () => {
        setFocused(false);
        setCandidateState(closeCardEditorCandidates());
        triggerPositionRef.current = undefined;
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        const { selection } = currentEditor.state;
        setSelectionEmpty(selection.empty);
        if (activityRef.current.kind !== 'active') return;
        const triggerPosition = triggerPositionRef.current;
        if (triggerPosition === undefined) return;
        const token = candidateTokenAtSelection(currentEditor);
        if (!token || token.from !== triggerPosition) {
          setCandidateState(closeCardEditorCandidates());
          triggerPositionRef.current = undefined;
        }
      },
    },
    [documentInput.cardId],
  );

  useLayoutEffect(() => {
    editorInstanceRef.current = editor;
    editorCardIdRef.current = editorCardId;
  }, [editor, editorCardId]);

  useEffect(() => {
    requestTitleFocus(titleInputRef.current);
  }, [editor, editorCardId, focusIntent, requestTitleFocus]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editorCardId !== documentInput.cardId) {
      pendingTitleRef.current = null;
      titleCompositionRef.current = false;
      persistedTitleRef.current = documentInput.title;
      observedTitleRef.current = documentInput.title;
      observedBodyKeyRef.current = inputBodyKey;
      persistedBodyKeyRef.current = inputBodyKey;
      bodySnapshotRef.current = null;
      return;
    }

    const pendingTitle = pendingTitleRef.current;
    const titleMatchesEditor =
      documentInput.title === persistedTitleRef.current ||
      (pendingTitle?.cardId === documentInput.cardId &&
        documentInput.title === pendingTitle.after);
    const titleIsStaleLocalEcho =
      documentInput.title === observedTitleRef.current &&
      persistedTitleRef.current !== observedTitleRef.current;
    const bodyMatchesEditor = inputBodyKey === persistedBodyKeyRef.current;
    const bodyIsStaleLocalEcho =
      inputBodyKey === observedBodyKeyRef.current &&
      persistedBodyKeyRef.current !== observedBodyKeyRef.current;
    if (
      (titleMatchesEditor || titleIsStaleLocalEcho) &&
      (bodyMatchesEditor || bodyIsStaleLocalEcho)
    ) {
      if (titleMatchesEditor) {
        observedTitleRef.current = documentInput.title;
      }
      if (bodyMatchesEditor) observedBodyKeyRef.current = inputBodyKey;
      return;
    }

    const nextDocument = editor.schema.nodeFromJSON(inputDocument);
    editor.view.updateState(
      EditorState.create({
        schema: editor.schema,
        doc: nextDocument,
        plugins: editor.state.plugins,
      }),
    );
    bodySnapshotRef.current = null;
    pendingTitleRef.current = null;
    titleCompositionRef.current = false;
    persistedTitleRef.current = documentInput.title;
    observedTitleRef.current = documentInput.title;
    observedBodyKeyRef.current = inputBodyKey;
    persistedBodyKeyRef.current = inputBodyKey;
    triggerPositionRef.current = undefined;
    const synchronizedCardId = documentInput.cardId;
    queueMicrotask(() => {
      if (
        !mountedRef.current ||
        documentRef.current.cardId !== synchronizedCardId
      ) {
        return;
      }
      setTitle(documentInput.title);
      setPendingTitleAvailability({ active: false, changed: false });
      setHistoryCanUndo(false);
      setHistoryCanRedo(false);
      setCandidateState(closeCardEditorCandidates());
      setSelectionEmpty(editor.state.selection.empty);
    });
  }, [
    editor,
    editorCardId,
    documentInput.cardId,
    documentInput.title,
    inputBodyKey,
    inputDocument,
  ]);

  const updateHistoryAvailability = (currentEditor: Editor) => {
    setHistoryCanUndo(currentEditor.can().undo());
    setHistoryCanRedo(currentEditor.can().redo());
  };

  const commitPendingTitle = (currentEditor: Editor): boolean => {
    const pending = pendingTitleRef.current;
    if (
      !pending ||
      pending.cardId !== documentRef.current.cardId ||
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

  useEffect(() => {
    if (activity.kind === 'active') return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setFocused(false);
      setCandidateState(closeCardEditorCandidates());
      triggerPositionRef.current = undefined;
      if (editor && !titleCompositionRef.current) commitPendingTitle(editor);
    });
    return () => {
      cancelled = true;
    };
  }, [activity.kind, editor]);

  const focusHistoryTarget = (
    currentEditor: Editor,
    titleChanged: boolean,
    bodyChanged: boolean,
  ) => {
    queueMicrotask(() => {
      if (
        !mountedRef.current ||
        currentEditor.isDestroyed ||
        editorCardId !== documentRef.current.cardId ||
        activityRef.current.kind !== 'active'
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
    if (
      !editor ||
      editor.isDestroyed ||
      editorCardId !== documentInput.cardId ||
      activityRef.current.kind !== 'active'
    ) {
      return;
    }
    commitPendingTitle(editor);
    const beforeTitle = titleFromEditor(editor);
    const beforeBody = readEditorBody(editor);
    const applied =
      direction === 'undo' ? editor.commands.undo() : editor.commands.redo();
    if (!applied) {
      updateHistoryAvailability(editor);
      return;
    }
    const afterTitle = titleFromEditor(editor);
    const afterBody = readEditorBody(editor);
    focusHistoryTarget(
      editor,
      beforeTitle !== afterTitle,
      beforeBody.key !== afterBody.key,
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
    if (
      editor &&
      !editor.isDestroyed &&
      editorCardId === documentInput.cardId
    ) {
      const currentPending = pendingTitleRef.current;
      if (currentPending?.cardId === documentInput.cardId) {
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
            cardId: documentInput.cardId,
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
    const key = {
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      composing: event.nativeEvent.isComposing || titleCompositionRef.current,
    };
    if (
      shouldMoveCardEditorTitleToBody(key) &&
      editor &&
      !editor.isDestroyed &&
      editorCardId === documentInput.cardId &&
      activityRef.current.kind === 'active'
    ) {
      event.preventDefault();
      event.stopPropagation();
      prepareBodyEditing();
      editor.commands.focus();
      return;
    }
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
    if (
      !editor ||
      editor.isDestroyed ||
      editorCardId !== documentInput.cardId ||
      activityRef.current.kind !== 'active'
    ) {
      return;
    }
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
    if (
      !editor ||
      editor.isDestroyed ||
      editorCardId !== documentInput.cardId ||
      activityRef.current.kind !== 'active'
    ) {
      return;
    }
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
    if (!editor || activityRef.current.kind !== 'active') return;
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

  const prepareBodyEditing = () => {
    if (editor) commitPendingTitle(editor);
  };

  return {
    model: {
      editor,
      title:
        editorCardId === documentInput.cardId ? title : documentInput.title,
      ready:
        editor !== null &&
        !editor.isDestroyed &&
        editorCardId === documentInput.cardId,
      focused,
      selectionEmpty,
      canUndo: pendingTitleAvailability.changed || historyCanUndo,
      canRedo: pendingTitleAvailability.active ? false : historyCanRedo,
      candidates,
      suggestionOpen:
        activity.kind === 'active' && normalizedCandidateState.open,
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
        if (editor && activityRef.current.kind === 'inactive') {
          commitPendingTitle(editor);
        }
      },
      prepareBodyEditing,
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
