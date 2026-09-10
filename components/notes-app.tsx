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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BodyEditor } from '@/components/body-editor';
import { ConflictNotice } from '@/components/conflict-notice';
import { ConnectionsView } from '@/components/connections-view';
import { HistoryView } from '@/components/history-view';
import { NotesProvider, useNotes, type NotesView } from '@/lib/client/notes-store';
import { formatDisplayId } from '@/lib/domain/display-id';

function StatusIndicator() {
  const { saveState, syncState, synchronizeNow } = useNotes();
  let label = '保存済み';
  let icon = <Save aria-hidden="true" className="size-3.5" />;
  let retry = false;

  if (saveState === 'failed') {
    label = '端末への保存に失敗';
    icon = <TriangleAlert aria-hidden="true" className="size-3.5" />;
  } else if (saveState === 'saving') {
    label = '保存中';
    icon = <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />;
  } else if (syncState === 'syncing') {
    label = '同期中';
    icon = <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />;
  } else if (syncState === 'offline') {
    label = 'オフライン・端末に保存済み';
    icon = <CloudOff aria-hidden="true" className="size-3.5" />;
  } else if (syncState === 'failed') {
    label = '同期失敗・端末に保存済み';
    icon = <TriangleAlert aria-hidden="true" className="size-3.5" />;
    retry = true;
  }

  return (
    <button
      type="button"
      onClick={retry ? () => void synchronizeNow() : undefined}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted disabled:pointer-events-none"
      disabled={!retry}
      aria-live="polite"
      data-testid="save-sync-status"
    >
      {icon}
      {label}
      {retry && <RefreshCw aria-hidden="true" className="size-3" />}
    </button>
  );
}

const navigation: { view: NotesView; label: string; icon: typeof NotebookPen }[] = [
  { view: 'card', label: 'カード', icon: NotebookPen },
  { view: 'history', label: '過去のカード', icon: History },
  { view: 'connections', label: 'つながり', icon: Network },
];

function Navigation() {
  const { view, setView, currentCard } = useNotes();
  return (
    <nav aria-label="表示切り替え" className="app-navigation">
      {navigation.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.view}
            type="button"
            aria-current={view === item.view ? 'page' : undefined}
            disabled={item.view !== 'history' && !currentCard}
            onClick={() => setView(item.view)}
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

function EmptyState() {
  const { createCard } = useNotes();
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
      <Button className="mt-6 rounded-full" size="lg" onClick={() => void createCard()}>
        <Plus aria-hidden="true" /> 新しいカード
      </Button>
    </section>
  );
}

function CardView() {
  const { cards, conflicts, currentCard, selectCard, updateCard, resolveConflict } = useNotes();
  if (!currentCard) return <EmptyState />;
  const currentConflicts = conflicts.filter((conflict) => conflict.cardId === currentCard.id);

  return (
    <section className="mx-auto w-full max-w-3xl" aria-label="カード編集">
      {currentConflicts.map((conflict) => (
        <ConflictNotice
          key={conflict.id}
          conflict={conflict}
          cards={cards}
          onResolve={(choice) => resolveConflict(conflict, choice)}
        />
      ))}
      <article className="paper-sheet min-h-[68vh] rounded-[1.5rem] border bg-card px-5 py-7 shadow-[0_18px_50px_rgb(55_45_35/8%)] sm:px-10 sm:py-10">
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-border/70 pb-4">
          <span
            className="font-mono text-sm font-semibold text-accent-foreground"
            data-testid="display-id"
            data-kind={currentCard.displayId.kind}
            data-value={currentCard.displayId.value}
          >
            {formatDisplayId(currentCard.displayId)}
          </span>
          <StatusIndicator />
        </div>
        <input
          aria-label="カードのタイトル"
          value={currentCard.title}
          onChange={(event) => updateCard(currentCard.id, { title: event.target.value })}
          className="mb-6 w-full bg-transparent font-heading text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/55"
          placeholder="Untitled"
          data-testid="card-title"
        />
        <BodyEditor
          key={currentCard.id}
          card={currentCard}
          cards={cards}
          onChange={(body) => updateCard(currentCard.id, { body })}
          onOpenCard={selectCard}
        />
      </article>
    </section>
  );
}

function NotesSurface() {
  const {
    cards,
    currentCard,
    currentCardId,
    initialized,
    view,
    createCard,
    selectCard,
  } = useNotes();

  if (!initialized) {
    return (
      <main className="grid min-h-dvh place-items-center text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> カードを開いています
        </span>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/92 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="font-heading text-lg font-semibold tracking-[0.08em]">FUKAMU Notes</p>
            <p className="hidden text-xs text-muted-foreground sm:block">一枚ずつ、考えを深める</p>
          </div>
          <Button className="rounded-full" onClick={() => void createCard()} data-testid="new-card">
            <Plus aria-hidden="true" /> 新しいカード
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 pb-28 pt-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_180px] lg:pb-12 lg:pt-12">
        <div className="min-w-0">
          {view === 'card' && <CardView />}
          {view === 'history' && (
            <HistoryView cards={cards} currentCardId={currentCardId} onSelect={selectCard} />
          )}
          {view === 'connections' && currentCard && (
            <ConnectionsView cards={cards} currentCardId={currentCard.id} onSelect={selectCard} />
          )}
        </div>
        <Navigation />
      </div>
    </main>
  );
}

export function NotesApp() {
  return (
    <NotesProvider>
      <NotesSurface />
    </NotesProvider>
  );
}
