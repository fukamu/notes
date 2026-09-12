'use client';

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
        className="c2-save-status c2-save-status-retryable"
        onClick={() => void actions.retrySync()}
        aria-live="polite"
        data-testid="save-sync-status"
      >
        <span>{model.status.label}</span>
        <span className="c2-retry-label">再試行</span>
      </button>
    );
  }

  return (
    <div
      className="c2-save-status"
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
            className="c2-nav-button"
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
    <section className="c2-empty-state">
      <h1 className="text-2xl font-bold sm:text-[1.75rem]">
        最初の一枚から始めましょう
      </h1>
      <p className="mt-3 max-w-md text-[1.0625rem] leading-[1.8125rem] text-muted-foreground">
        タイトルも本文も空のままで構いません。作成した瞬間から、この端末に保存されます。
      </p>
      <Button
        className="mt-6 h-11 rounded-md px-4 focus-visible:ring-2"
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
    <section
      className={`c2-card-layout${model.conflicts.length > 0 ? ' c2-card-layout-conflict' : ''}`}
      aria-label="カード編集"
    >
      <article
        className={`c2-manuscript${model.conflicts.length > 0 ? ' c2-manuscript-conflict' : ''}`}
      >
        <span
          className="c2-card-id"
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
          className="c2-card-title"
          placeholder="タイトル"
          data-testid="card-title"
        />
        {model.conflicts.length > 0 && (
          <div className="c2-conflict-list">
            {model.conflicts.map((conflict) => (
              <ConflictNotice
                key={conflict.conflictId}
                model={conflict}
                onResolve={(choice) =>
                  actions.resolveConflict(conflict.conflictId, choice)
                }
              />
            ))}
          </div>
        )}
        {model.cardEditor &&
          features.renderCardEditor({
            input: model.cardEditor,
            actions,
          })}
      </article>
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
        <span>カードを開いています</span>
      </main>
    );
  }

  const hasVisibleConflict =
    model.activeView === 'card' && model.conflicts.length > 0;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="c2-app-header">
        <div className="c2-app-header-inner">
          <div className="c2-brand">
            <p>FUKAMU Notes</p>
            <p>一枚ずつ、考えを深める</p>
          </div>
          <Navigation model={model} actions={actions} />
          <Button
            className="c2-new-card focus-visible:ring-2"
            onClick={() => void actions.createCard()}
            data-testid="new-card"
          >
            新しいカード
          </Button>
        </div>
      </header>

      <div
        className={`c2-view-frame c2-view-frame-${model.activeView}${hasVisibleConflict ? ' c2-view-frame-conflict' : ''}`}
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
