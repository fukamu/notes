'use client';

import { LoaderCircle } from 'lucide-react';
import { ConflictNotice } from '@/components/conflict-notice';
import { HistoryView } from '@/components/history-view';
import type { NotesPresentationProps } from '@/components/presentation-contract';
import { Button } from '@/components/ui/button';
import type {
  NotesPresentationActions,
  NotesViewName,
} from '@/lib/application/presentation';

function StatusIndicator({
  model,
  actions,
}: Pick<NotesPresentationProps, 'model' | 'actions'>) {
  if (model.status.retryable) {
    return (
      <button
        type="button"
        className="e2-save-status e2-save-status-retryable"
        onClick={() => void actions.retrySync()}
        aria-live="polite"
        data-testid="save-sync-status"
      >
        <span>{model.status.label}</span>
        <span className="e2-retry-label">再試行</span>
      </button>
    );
  }

  return (
    <div
      className="e2-save-status"
      aria-live="polite"
      data-testid="save-sync-status"
    >
      <span>{model.status.label}</span>
    </div>
  );
}

const navigation: {
  view: NotesViewName;
  label: string;
  activate: keyof Pick<
    NotesPresentationActions,
    'showCurrentCard' | 'showHistory' | 'showConnections'
  >;
}[] = [
  {
    view: 'card',
    label: 'カード',
    activate: 'showCurrentCard',
  },
  {
    view: 'history',
    label: '過去のカード',
    activate: 'showHistory',
  },
  {
    view: 'connections',
    label: 'つながり',
    activate: 'showConnections',
  },
];

function Navigation({
  model,
  actions,
}: Pick<NotesPresentationProps, 'model' | 'actions'>) {
  return (
    <nav aria-label="表示切り替え" className="app-navigation">
      {navigation.map((item) => {
        return (
          <button
            key={item.view}
            type="button"
            aria-current={model.activeView === item.view ? 'page' : undefined}
            disabled={!model.availableViews[item.view]}
            onClick={() => actions[item.activate]()}
            className="e2-nav-button"
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

function EmptyState({ actions }: Pick<NotesPresentationProps, 'actions'>) {
  return (
    <section className="e2-empty-state">
      <h1 className="text-2xl font-bold sm:text-[1.75rem]">
        最初の一枚から始めましょう
      </h1>
      <p className="mt-3 max-w-md text-[1.0625rem] leading-[1.8125rem] text-muted-foreground">
        タイトルも本文も空のままで構いません。作成した瞬間から、この端末に保存されます。
      </p>
      <Button
        className="mt-6 h-11 px-4"
        variant="outline"
        onClick={() => void actions.createCard()}
      >
        新しいカード
      </Button>
    </section>
  );
}

function CardView({ model, actions, features }: NotesPresentationProps) {
  const card = model.currentCard;
  if (!card) return <EmptyState actions={actions} />;

  return (
    <section className="e2-card-layout" aria-label="カード編集">
      <div className="e2-manuscript-column">
        {model.conflicts.map((conflict) => (
          <ConflictNotice
            key={conflict.conflictId}
            model={conflict}
            onResolve={(choice) =>
              actions.resolveConflict(conflict.conflictId, choice)
            }
          />
        ))}
        <article className="e2-manuscript">
          <span
            className="e2-card-id"
            data-testid="display-id"
            data-kind={card.displayId.kind}
            data-value={card.displayId.value}
          >
            {model.currentCardDisplayLabel}
          </span>
          <StatusIndicator model={model} actions={actions} />
          <input
            aria-label="カードのタイトル"
            value={card.title}
            onChange={(event) => actions.updateTitle(event.target.value)}
            className="e2-card-title"
            placeholder="タイトル"
            data-testid="card-title"
          />
          {model.cardEditor &&
            features.renderCardEditor({
              input: model.cardEditor,
              actions,
            })}
        </article>
      </div>

      {model.cardEditor && model.cardEditor.outgoingLinks.length > 0 && (
        <aside className="e2-outgoing-index" aria-labelledby="outgoing-heading">
          <h2 id="outgoing-heading">本文にあるリンク</h2>
          <p>本文で最初に現れる順</p>
          <ul>
            {model.cardEditor.outgoingLinks.map((link) => (
              <li key={link.cardId}>
                <button
                  type="button"
                  aria-label={link.accessibleName}
                  onClick={() => actions.openCard(link.cardId)}
                >
                  <span aria-hidden="true" className="e2-outgoing-arrow">
                    →
                  </span>
                  <span>
                    <span className="e2-outgoing-id">{link.displayLabel}</span>
                    <span className="e2-outgoing-title">{link.title}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

export function NotesPresentation({
  model,
  actions,
  features,
}: NotesPresentationProps) {
  if (!model.initialized) {
    return (
      <main className="grid min-h-dvh place-items-center text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{' '}
          カードを開いています
        </span>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="e2-app-header">
        <div className="e2-app-header-inner">
          <div className="e2-brand">
            <p>FUKAMU Notes</p>
            <p>一枚ずつ、考えを深める</p>
          </div>
          <Navigation model={model} actions={actions} />
          <Button
            className="e2-new-card"
            onClick={() => void actions.createCard()}
            data-testid="new-card"
          >
            新しいカード
          </Button>
        </div>
      </header>

      <div
        className={`e2-view-frame ${model.activeView === 'connections' ? 'e2-view-frame-wide' : ''}`}
      >
        {model.activeView === 'card' && (
          <CardView model={model} actions={actions} features={features} />
        )}
        {model.activeView === 'history' && (
          <HistoryView model={model.history} onOpenCard={actions.openCard} />
        )}
        {model.activeView === 'connections' &&
          model.connections &&
          features.renderConnections({
            input: model.connections,
            actions,
          })}
      </div>
    </main>
  );
}
