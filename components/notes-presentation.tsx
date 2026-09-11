'use client';

import {
  CloudOff,
  History,
  LoaderCircle,
  Network,
  NotebookPen,
  Plus,
  RefreshCw,
  Save,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { ConflictNotice } from '@/components/conflict-notice';
import { HistoryView } from '@/components/history-view';
import type { NotesPresentationProps } from '@/components/presentation-contract';
import { Button } from '@/components/ui/button';
import type {
  NotesPresentationActions,
  NotesStatusKind,
  NotesViewName,
} from '@/lib/application/presentation';

function StatusIcon({ kind }: { kind: NotesStatusKind }) {
  if (kind === 'saved') {
    return <Save aria-hidden="true" className="size-3.5" />;
  }
  if (kind === 'offline') {
    return <CloudOff aria-hidden="true" className="size-3.5" />;
  }
  if (kind === 'saving' || kind === 'syncing') {
    return (
      <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
    );
  }
  return <TriangleAlert aria-hidden="true" className="size-3.5" />;
}

function StatusIndicator({
  model,
  actions,
}: Pick<NotesPresentationProps, 'model' | 'actions'>) {
  return (
    <button
      type="button"
      onClick={
        model.status.retryable ? () => void actions.retrySync() : undefined
      }
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted disabled:pointer-events-none"
      disabled={!model.status.retryable}
      aria-live="polite"
      data-testid="save-sync-status"
    >
      <StatusIcon kind={model.status.kind} />
      {model.status.label}
      {model.status.retryable && (
        <RefreshCw aria-hidden="true" className="size-3" />
      )}
    </button>
  );
}

const navigation: {
  view: NotesViewName;
  label: string;
  icon: LucideIcon;
  activate: keyof Pick<
    NotesPresentationActions,
    'showCurrentCard' | 'showHistory' | 'showConnections'
  >;
}[] = [
  {
    view: 'card',
    label: 'カード',
    icon: NotebookPen,
    activate: 'showCurrentCard',
  },
  {
    view: 'history',
    label: '過去のカード',
    icon: History,
    activate: 'showHistory',
  },
  {
    view: 'connections',
    label: 'つながり',
    icon: Network,
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
        const Icon = item.icon;
        return (
          <button
            key={item.view}
            type="button"
            aria-current={model.activeView === item.view ? 'page' : undefined}
            disabled={!model.availableViews[item.view]}
            onClick={() => actions[item.activate]()}
            className="nav-button aria-[current=page]:nav-button-active disabled:opacity-35"
          >
            <Icon aria-hidden="true" className="size-4" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function EmptyState({ actions }: Pick<NotesPresentationProps, 'actions'>) {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center rounded-3xl border border-dashed bg-card/45 px-6 text-center">
      <div className="mb-5 rounded-full bg-accent p-4 text-accent-foreground">
        <NotebookPen aria-hidden="true" className="size-7" />
      </div>
      <p className="eyebrow">YOUR FIRST CARD</p>
      <h1 className="font-heading text-[1.35rem] font-semibold sm:text-2xl">
        最初の一枚から始めましょう
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        タイトルも本文も空のままで構いません。作成した瞬間から、この端末に保存されます。
      </p>
      <Button
        className="mt-6 rounded-full"
        size="lg"
        onClick={() => void actions.createCard()}
      >
        <Plus aria-hidden="true" /> 新しいカード
      </Button>
    </section>
  );
}

function CardView({ model, actions, features }: NotesPresentationProps) {
  const card = model.currentCard;
  if (!card) return <EmptyState actions={actions} />;

  return (
    <section className="mx-auto w-full max-w-3xl" aria-label="カード編集">
      {model.conflicts.map((conflict) => (
        <ConflictNotice
          key={conflict.conflictId}
          model={conflict}
          onResolve={(choice) =>
            actions.resolveConflict(conflict.conflictId, choice)
          }
        />
      ))}
      <article className="paper-sheet min-h-[68vh] rounded-[1.5rem] border bg-card px-5 py-7 shadow-[0_18px_50px_rgb(55_45_35/8%)] sm:px-10 sm:py-10">
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-border/70 pb-4">
          <span
            className="font-mono text-sm font-semibold text-accent-foreground"
            data-testid="display-id"
            data-kind={card.displayId.kind}
            data-value={card.displayId.value}
          >
            {model.currentCardDisplayLabel}
          </span>
          <StatusIndicator model={model} actions={actions} />
        </div>
        <input
          aria-label="カードのタイトル"
          value={card.title}
          onChange={(event) => actions.updateTitle(event.target.value)}
          className="mb-6 w-full bg-transparent font-heading text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/55"
          placeholder="Untitled"
          data-testid="card-title"
        />
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
        <span className="inline-flex items-center gap-2">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{' '}
          カードを開いています
        </span>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/92 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="font-heading text-lg font-semibold tracking-[0.08em]">
              FUKAMU Notes
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              一枚ずつ、考えを深める
            </p>
          </div>
          <Button
            className="rounded-full"
            onClick={() => void actions.createCard()}
            data-testid="new-card"
          >
            <Plus aria-hidden="true" /> 新しいカード
          </Button>
        </div>
      </header>

      <div
        className={`grid w-full px-4 pb-28 pt-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_180px] lg:pb-12 ${
          model.activeView === 'connections'
            ? 'max-w-none gap-4 lg:gap-6 lg:pt-8'
            : 'mx-auto max-w-6xl gap-8 lg:pt-12'
        }`}
      >
        <div className="min-w-0">
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
        <Navigation model={model} actions={actions} />
      </div>
    </main>
  );
}
