'use client';

import { Fragment, useEffect, useRef } from 'react';
import { EditorContent } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import type { CardEditorRendererProps } from '@/components/presentation-contract';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';

export const defaultCardEditorPresentation: CardEditorPresentationAdapter = {
  contentAttributes: {
    class: 'card-editor-structure fukamu-editor',
    'aria-label': 'カードの本文',
    role: 'textbox',
    'aria-multiline': 'true',
    'data-testid': 'body-editor',
  },
  cardLinkNodeView: {
    className: 'card-link-structure card-link-capsule',
  },
};

export function BodyEditor({ model, commands }: CardEditorRendererProps) {
  const activeCandidateRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (model.suggestionOpen) {
      activeCandidateRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [model.activeCandidate, model.suggestionOpen]);

  return (
    <Fragment>
      <div
        className="e2-editor-history-toolbar"
        role="toolbar"
        aria-label="編集履歴"
      >
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          disabled={!model.ready || !model.canUndo}
          onClick={commands.undo}
          data-testid="undo"
        >
          元に戻す
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          disabled={!model.ready || !model.canRedo}
          onClick={commands.redo}
          data-testid="redo"
        >
          やり直す
        </Button>
      </div>

      <div
        className="e2-editor-content"
        data-editor-focused={model.focused ? 'true' : 'false'}
        data-selection-empty={model.selectionEmpty ? 'true' : 'false'}
      >
        {!model.ready || !model.editor ? (
          <div
            className="min-h-72 animate-pulse rounded-lg bg-muted/35"
            aria-label="本文を準備中"
          />
        ) : (
          <>
            <EditorContent
              editor={model.editor}
              onKeyDownCapture={commands.handleKeyDown}
              onInput={commands.handleInput}
              onCompositionEnd={commands.handleCompositionEnd}
            />

            {model.suggestionOpen && (
              <div className="e2-link-candidates">
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  リンクするカードを選択
                </p>
                <div
                  className="overflow-y-auto"
                  style={{ maxHeight: 'min(14rem, calc(100dvh - 12rem))' }}
                  data-testid="link-candidate-scroll"
                >
                  {model.candidates.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      該当するカードがありません
                    </p>
                  ) : (
                    <ul
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
                              index === model.activeCandidate
                                ? 'true'
                                : undefined
                            }
                            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                            onPointerDown={commands.preserveEditorFocus}
                            onClick={() =>
                              commands.selectCandidate(candidate.cardId)
                            }
                          >
                            <span className="font-mono text-xs font-medium text-muted-foreground">
                              {candidate.displayLabel}
                            </span>
                            <span className="truncate">{candidate.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Fragment>
  );
}
