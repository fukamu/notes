'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { Link2, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { linkCandidates } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import type { BodySegment, CardRecord } from '@/lib/domain/types';
import { visibleTitle } from '@/lib/domain/types';
import { CardLink } from '@/lib/editor/card-link-extension';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';
import { setCardLabels } from '@/lib/editor/card-labels';

type Props = {
  card: CardRecord;
  cards: CardRecord[];
  onChange: (body: BodySegment[]) => void;
  onOpenCard: (cardId: string) => void;
};

export function BodyEditor({ card, cards, onChange, onOpenCard }: Props) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [activeCandidate, setActiveCandidate] = useState(0);
  const triggerPositionRef = useRef<number | undefined>(undefined);
  const compositionInputRef = useRef(false);
  const candidates = useMemo(
    () => linkCandidates(cards, card.id),
    [cards, card.id],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
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
      }),
      CardLink,
    ],
    content: segmentsToEditorDocument(card.body),
    editorProps: {
      attributes: {
        class: 'fukamu-editor',
        'aria-label': 'カードの本文',
        role: 'textbox',
        'aria-multiline': 'true',
        'data-testid': 'body-editor',
      },
      transformPastedHTML: (html) =>
        html.replace(/<(?!\/?(?:p|br|span)(?:\s|>|\/))[^>]+>/gi, ''),
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChange(editorDocumentToSegments(currentEditor.getJSON()));
    },
    onTransaction: ({ editor: currentEditor }) => {
      setCanUndo(currentEditor.can().undo());
      setCanRedo(currentEditor.can().redo());
    },
  });

  useEffect(() => {
    setCardLabels(cards);
  }, [cards]);

  useEffect(() => {
    if (!editor) return;
    const editorBody = editorDocumentToSegments(editor.getJSON());
    if (JSON.stringify(editorBody) !== JSON.stringify(card.body)) {
      editor.commands.setContent(segmentsToEditorDocument(card.body), {
        emitUpdate: false,
      });
    }
  }, [editor, card.id, card.body]);

  function insertCandidate(candidate: CardRecord) {
    if (!editor || triggerPositionRef.current === undefined) return;
    const from = triggerPositionRef.current;
    const to = editor.state.selection.from;
    if (editor.state.doc.textBetween(from, to, '\n') !== '#') {
      setSuggestionOpen(false);
      return;
    }
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({
        type: 'cardLink',
        attrs: { targetCardId: candidate.id },
      })
      .run();
    editor.view.dispatch(closeHistory(editor.state.tr));
    setSuggestionOpen(false);
    triggerPositionRef.current = undefined;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!editor || event.nativeEvent.isComposing) return;

    if (suggestionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setActiveCandidate((current) => {
          if (candidates.length === 0) return 0;
          return (current + direction + candidates.length) % candidates.length;
        });
        return;
      }
      if (event.key === 'Enter' && candidates[activeCandidate]) {
        event.preventDefault();
        insertCandidate(candidates[activeCandidate]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuggestionOpen(false);
        return;
      }
      if (
        event.key.length === 1 ||
        event.key === 'Backspace' ||
        event.key === 'Delete'
      ) {
        setSuggestionOpen(false);
      }
    }
  }

  function openSuggestionsForInsertedHash() {
    if (!editor) return;
    const { selection, doc } = editor.state;
    if (!selection.empty) return;
    const to = selection.from;
    const from = to - 1;
    if (from < 1 || doc.textBetween(from, to, '\n') !== '#') return;
    const previous = from > 1 ? doc.textBetween(from - 1, from, '\n') : '';
    if (previous && /[\p{L}\p{N}_]/u.test(previous)) return;
    triggerPositionRef.current = from;
    setActiveCandidate(0);
    setSuggestionOpen(true);
  }

  function closeSuggestionsIfTriggerChanged() {
    if (!editor || triggerPositionRef.current === undefined) return;
    const { selection, doc } = editor.state;
    const triggerPosition = triggerPositionRef.current;
    if (
      !selection.empty ||
      doc.textBetween(triggerPosition, selection.from, '\n') !== '#'
    ) {
      setSuggestionOpen(false);
      triggerPositionRef.current = undefined;
    }
  }

  function handleInput(event: SyntheticEvent<HTMLDivElement, InputEvent>) {
    const inputEvent = event.nativeEvent;
    const insertsTypedText =
      inputEvent.inputType === 'insertText' ||
      inputEvent.inputType === 'insertCompositionText';

    if (insertsTypedText && inputEvent.isComposing) {
      compositionInputRef.current = true;
      return;
    }
    if (insertsTypedText) {
      queueMicrotask(() => {
        openSuggestionsForInsertedHash();
        closeSuggestionsIfTriggerChanged();
      });
      return;
    }
    queueMicrotask(closeSuggestionsIfTriggerChanged);
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLDivElement>) {
    const hadCompositionInput =
      compositionInputRef.current || event.data.length > 0;
    compositionInputRef.current = false;
    if (hadCompositionInput) queueMicrotask(openSuggestionsForInsertedHash);
  }

  if (!editor) {
    return (
      <div
        className="min-h-72 animate-pulse rounded-xl bg-muted/35"
        aria-label="本文を準備中"
      />
    );
  }

  return (
    <div className="relative">
      <EditorContent
        editor={editor}
        onKeyDownCapture={handleKeyDown}
        onInput={handleInput}
        onCompositionEnd={handleCompositionEnd}
        onClick={(event) => {
          if (!(event.target instanceof Element)) return;
          const element = event.target.closest<HTMLElement>(
            '[data-card-link-id]',
          );
          const targetCardId = element?.dataset.cardLinkId;
          if (targetCardId) onOpenCard(targetCardId);
        }}
      />

      {suggestionOpen && (
        <div className="absolute left-0 top-12 z-20 w-full max-w-sm rounded-xl border bg-popover p-1.5 shadow-xl">
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            リンクするカードを選択
          </p>
          <div className="max-h-56 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                ほかのカードがありません
              </p>
            ) : (
              <ul
                aria-label="リンクするカードを選ぶ"
                data-testid="link-candidates"
              >
                {candidates.map((candidate, index) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      aria-current={
                        index === activeCandidate ? 'true' : undefined
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertCandidate(candidate)}
                    >
                      <Link2
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-[color:var(--link-foreground)]"
                      />
                      <span className="font-mono text-xs font-semibold">
                        {formatDisplayId(candidate.displayId)}
                      </span>
                      <span className="truncate">
                        {visibleTitle(candidate.title)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div
        className="mt-8 flex items-center gap-1 border-t border-border/70 pt-4"
        role="toolbar"
        aria-label="編集履歴"
      >
        <Button
          type="button"
          variant="ghost"
          disabled={!canUndo}
          onClick={() => editor.chain().focus().undo().run()}
          data-testid="undo"
        >
          <Undo2 aria-hidden="true" /> 元に戻す
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!canRedo}
          onClick={() => editor.chain().focus().redo().run()}
          data-testid="redo"
        >
          <Redo2 aria-hidden="true" /> やり直す
        </Button>
      </div>
    </div>
  );
}
