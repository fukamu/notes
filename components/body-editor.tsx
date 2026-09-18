'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent } from '@tiptap/react';
import { Link2, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CardEditorRendererProps } from '@/components/presentation-contract';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';
import {
  useCardEditorCandidatePopover,
  useCardEditorInputVisibility,
} from '@/components/use-card-editor-viewport';

export const defaultCardEditorPresentation: CardEditorPresentationAdapter = {
  contentAttributes: {
    class: 'card-editor-structure fukamu-editor',
    'aria-label': 'カードの本文',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-autocomplete': 'list',
    'aria-controls': 'card-editor-link-candidates',
    'aria-haspopup': 'listbox',
    'data-testid': 'body-editor',
  },
  cardLinkNodeView: {
    className: 'card-link-structure card-link-capsule',
  },
};

export function BodyEditor({ model, commands }: CardEditorRendererProps) {
  const activeCandidateRef = useRef<HTMLButtonElement>(null);
  const candidateListRef = useRef<HTMLDivElement>(null);
  const candidatePopoverRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [focusedInput, setFocusedInput] = useState<'title' | 'body' | null>(
    null,
  );
  const candidatePlacement = useCardEditorCandidatePopover(
    model.editor,
    model.suggestionOpen,
    candidatePopoverRef,
  );
  const inputVisibility = useCardEditorInputVisibility(
    model.editor,
    focusedInput,
    titleInputRef,
  );
  const setTitleInputElement = commands.setTitleInputElement;
  useEffect(() => {
    setTitleInputElement(titleInputRef.current);
    return () => setTitleInputElement(null);
  }, [setTitleInputElement]);
  useEffect(() => {
    if (model.suggestionOpen) {
      const active = activeCandidateRef.current;
      const list = candidateListRef.current;
      if (!active || !list) return;
      const activeRect = active.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      if (activeRect.top < listRect.top) {
        list.scrollTop -= listRect.top - activeRect.top;
      } else if (activeRect.bottom > listRect.bottom) {
        list.scrollTop += activeRect.bottom - listRect.bottom;
      }
    }
  }, [model.activeCandidate, model.suggestionOpen]);

  const requestInputVisibility = () => {
    queueMicrotask(inputVisibility.requestVisibility);
  };

  const titleInput = (
    <input
      ref={titleInputRef}
      aria-label="カードのタイトル"
      value={model.title}
      disabled={!model.ready}
      onChange={(event) => {
        commands.updateTitle(event.target.value);
        requestInputVisibility();
      }}
      onFocus={() => setFocusedInput('title')}
      onBlur={() => {
        setFocusedInput(null);
        commands.handleTitleBlur();
      }}
      onKeyDown={commands.handleTitleKeyDown}
      onCompositionStart={() => {
        inputVisibility.startComposition();
        commands.handleTitleCompositionStart();
      }}
      onCompositionEnd={() => {
        commands.handleTitleCompositionEnd();
        inputVisibility.endComposition();
      }}
      className="mb-6 w-full bg-transparent font-heading text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/55"
      placeholder="Untitled"
      data-testid="card-title"
    />
  );

  if (!model.ready || !model.editor) {
    return (
      <div>
        {titleInput}
        <div
          className="min-h-72 animate-pulse rounded-xl bg-muted/35"
          aria-label="本文を準備中"
        />
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={
        inputVisibility.bottomPadding > 0
          ? { paddingBottom: inputVisibility.bottomPadding }
          : undefined
      }
      data-editor-focused={model.focused ? 'true' : 'false'}
      data-selection-empty={model.selectionEmpty ? 'true' : 'false'}
      data-editor-bottom-padding={inputVisibility.bottomPadding}
    >
      {titleInput}
      <EditorContent
        editor={model.editor}
        onFocusCapture={() => {
          setFocusedInput('body');
          commands.prepareBodyEditing();
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusedInput(null);
          }
        }}
        onPointerDownCapture={commands.prepareBodyEditing}
        onKeyDownCapture={commands.handleKeyDown}
        onInput={(event) => {
          commands.handleInput(event);
          requestInputVisibility();
        }}
        onCompositionStart={inputVisibility.startComposition}
        onCompositionEnd={(event) => {
          commands.handleCompositionEnd(event);
          inputVisibility.endComposition();
        }}
      />

      {model.suggestionOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={candidatePopoverRef}
            className="fixed z-50 flex max-w-sm flex-col rounded-xl border bg-popover p-1.5 shadow-xl"
            style={{
              position: 'absolute',
              left: candidatePlacement?.left ?? 0,
              top: candidatePlacement?.top ?? 0,
              width: candidatePlacement?.width ?? 'min(24rem, 100%)',
              maxHeight: candidatePlacement?.maxHeight ?? 272,
              visibility: candidatePlacement ? 'visible' : 'hidden',
            }}
            data-testid="link-candidate-popover"
            data-side={candidatePlacement?.side}
          >
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              リンクするカードを選択
            </p>
            <div
              ref={candidateListRef}
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="link-candidate-scroll"
            >
              {model.candidates.length === 0 ? (
                <p className="px-2 py-4 text-sm text-muted-foreground">
                  該当するカードがありません
                </p>
              ) : (
                <ul
                  id="card-editor-link-candidates"
                  aria-label="リンクするカードを選ぶ"
                  data-testid="link-candidates"
                >
                  {model.candidates.map((candidate, index) => (
                    <li key={candidate.cardId}>
                      <button
                        ref={
                          index === model.activeCandidate
                            ? activeCandidateRef
                            : undefined
                        }
                        type="button"
                        aria-current={
                          index === model.activeCandidate ? 'true' : undefined
                        }
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                        onPointerDown={commands.preserveEditorFocus}
                        onClick={() =>
                          commands.selectCandidate(candidate.cardId)
                        }
                      >
                        <Link2
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-[color:var(--link-foreground)]"
                        />
                        <span className="font-mono text-xs font-semibold">
                          {candidate.displayLabel}
                        </span>
                        <span className="truncate">{candidate.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>,
          document.body,
        )}

      <div
        className="mt-8 flex items-center gap-1 border-t border-border/70 pt-4"
        role="toolbar"
        aria-label="編集履歴"
      >
        <Button
          type="button"
          variant="ghost"
          disabled={!model.canUndo}
          onClick={commands.undo}
          data-testid="undo"
        >
          <Undo2 aria-hidden="true" /> 元に戻す
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!model.canRedo}
          onClick={commands.redo}
          data-testid="redo"
        >
          <Redo2 aria-hidden="true" /> やり直す
        </Button>
      </div>
    </div>
  );
}
