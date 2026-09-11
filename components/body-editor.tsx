'use client';

import { EditorContent } from '@tiptap/react';
import { Link2, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  CardEditorCommands,
  CardEditorModel,
  CardEditorPresentationAdapter,
} from '@/lib/editor/use-card-editor';

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

type Props = {
  model: CardEditorModel;
  commands: CardEditorCommands;
};

export function BodyEditor({ model, commands }: Props) {
  if (!model.ready || !model.editor) {
    return (
      <div
        className="min-h-72 animate-pulse rounded-xl bg-muted/35"
        aria-label="本文を準備中"
      />
    );
  }

  return (
    <div
      className="relative"
      data-editor-focused={model.focused ? 'true' : 'false'}
      data-selection-empty={model.selectionEmpty ? 'true' : 'false'}
    >
      <EditorContent
        editor={model.editor}
        onKeyDownCapture={commands.handleKeyDown}
        onInput={commands.handleInput}
        onCompositionEnd={commands.handleCompositionEnd}
      />

      {model.suggestionOpen && (
        <div className="absolute left-0 top-12 z-20 w-full max-w-sm rounded-xl border bg-popover p-1.5 shadow-xl">
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            リンクするカードを選択
          </p>
          <div className="max-h-56 overflow-y-auto">
            {model.candidates.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                ほかのカードがありません
              </p>
            ) : (
              <ul
                aria-label="リンクするカードを選ぶ"
                data-testid="link-candidates"
              >
                {model.candidates.map((candidate, index) => (
                  <li key={candidate.cardId}>
                    <button
                      type="button"
                      aria-current={
                        index === model.activeCandidate ? 'true' : undefined
                      }
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                      onMouseDown={commands.preserveEditorFocus}
                      onClick={() => commands.selectCandidate(candidate.cardId)}
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
