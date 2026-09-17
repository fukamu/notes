'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ListTree, Search, X } from 'lucide-react';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  prepareConnectionsSemanticIndex,
  resolveConnectionsDeletedCardFocusTarget,
  selectConnectionsSemanticPage,
  type ConnectionsSemanticPage,
} from '@/lib/graph/connections-semantic-list';

type Props = Readonly<{
  input: ConnectionsInputModel;
  canMoveToMap: boolean;
  openCard: (cardId: CardId) => void;
  moveToMap: (cardId: CardId) => void;
}>;

type PageControlsProps = Readonly<{
  label: string;
  page: ConnectionsSemanticPage<Readonly<{ searchText: string }>>;
  setPage: (page: number) => void;
}>;

function PageControls({ label, page, setPage }: PageControlsProps) {
  return (
    <nav
      className="flex flex-wrap items-center gap-2"
      aria-label={`${label}のページ`}
    >
      <button
        type="button"
        className="connections-semantic-page-button"
        disabled={page.page <= 1}
        onClick={() => setPage(page.page - 1)}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        前へ
      </button>
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        ページ
        <input
          type="number"
          className="connections-semantic-page-input"
          min={1}
          max={page.pageCount}
          value={page.page}
          aria-label={`${label}のページ番号`}
          onChange={(event) => {
            const nextPage = Number(event.currentTarget.value);
            if (Number.isSafeInteger(nextPage)) setPage(nextPage);
          }}
        />
        <span>/ {page.pageCount.toLocaleString('ja-JP')}</span>
      </label>
      <button
        type="button"
        className="connections-semantic-page-button"
        disabled={page.page >= page.pageCount}
        onClick={() => setPage(page.page + 1)}
      >
        次へ
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
    </nav>
  );
}

function PageStatus({
  label,
  page,
}: Readonly<{
  label: string;
  page: ConnectionsSemanticPage<Readonly<{ searchText: string }>>;
}>) {
  const visibleRange =
    page.filteredCount === 0
      ? '表示0件'
      : `${page.rangeStart.toLocaleString('ja-JP')}〜${page.rangeEnd.toLocaleString('ja-JP')}件目`;
  return (
    <output className="text-xs text-muted-foreground" aria-live="polite">
      {label}: 検索結果{page.filteredCount.toLocaleString('ja-JP')}件 / 全
      {page.totalCount.toLocaleString('ja-JP')}件、{visibleRange}
    </output>
  );
}

export function ConnectionsSemanticLists({
  input,
  canMoveToMap,
  openCard,
  moveToMap,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const cardSearchRef = useRef<HTMLInputElement>(null);
  const cardListRef = useRef<HTMLOListElement>(null);
  const focusedCardRowRef = useRef<Readonly<{
    cardId: CardId;
    pageIndex: number;
  }> | null>(null);
  const [open, setOpen] = useState(false);
  const prepared = useMemo(
    () =>
      open ? prepareConnectionsSemanticIndex(input) : { cards: [], edges: [] },
    [input, open],
  );
  const [cardQuery, setCardQuery] = useState('');
  const [cardPageNumber, setCardPageNumber] = useState(1);
  const [edgeQuery, setEdgeQuery] = useState('');
  const [edgePageNumber, setEdgePageNumber] = useState(1);
  const cardPage = useMemo(
    () =>
      selectConnectionsSemanticPage(prepared.cards, cardQuery, cardPageNumber),
    [cardPageNumber, cardQuery, prepared.cards],
  );
  const edgePage = useMemo(
    () =>
      selectConnectionsSemanticPage(prepared.edges, edgeQuery, edgePageNumber),
    [edgePageNumber, edgeQuery, prepared.edges],
  );

  useLayoutEffect(() => {
    const focused = focusedCardRowRef.current;
    if (!open || !focused) return;
    const target = resolveConnectionsDeletedCardFocusTarget(
      focused.cardId,
      focused.pageIndex,
      prepared.cards,
      cardPage.items,
    );
    if (target.kind === 'unchanged') return;
    if (document.activeElement !== document.body) {
      focusedCardRowRef.current = null;
      return;
    }
    const rows = cardListRef.current?.querySelectorAll<HTMLElement>(
      '[data-semantic-card-row]',
    );
    const nextRow =
      target.kind === 'item' ? rows?.item(target.pageIndex) : null;
    const nextButton = nextRow?.querySelector<HTMLButtonElement>('button');
    if (nextButton) nextButton.focus();
    else cardSearchRef.current?.focus();
    focusedCardRowRef.current = null;
  }, [cardPage.items, open, prepared.cards]);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setOpen(false);
    summaryRef.current?.focus();
  };

  return (
    <details
      ref={detailsRef}
      className="mb-4 rounded-xl border bg-card/70 shadow-sm"
      data-testid="connections-semantic-lists"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        ref={summaryRef}
        className="flex min-h-11 cursor-pointer items-center gap-2 px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ListTree aria-hidden="true" className="size-4" />
        カードと参照の一覧
      </summary>

      {open && (
        <div className="grid gap-6 border-t p-4 lg:grid-cols-2">
          <section aria-labelledby="connections-card-list-heading">
            <h2
              id="connections-card-list-heading"
              className="font-heading text-lg font-semibold"
            >
              カード一覧
            </h2>
            <label className="mt-3 block text-xs font-medium text-muted-foreground">
              カード番号・タイトルを検索
              <span className="mt-1 flex items-center gap-2 rounded-lg border bg-background px-3">
                <Search aria-hidden="true" className="size-4 shrink-0" />
                <input
                  ref={cardSearchRef}
                  type="search"
                  className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                  value={cardQuery}
                  onChange={(event) => {
                    setCardQuery(event.currentTarget.value);
                    setCardPageNumber(1);
                  }}
                />
              </span>
            </label>
            <div className="mt-3 grid gap-2">
              <PageStatus label="カード一覧" page={cardPage} />
              <PageControls
                label="カード一覧"
                page={cardPage}
                setPage={setCardPageNumber}
              />
            </div>
            <ol
              ref={cardListRef}
              className="mt-3 grid gap-2"
              aria-label="検索されたカード一覧"
              start={cardPage.rangeStart || 1}
            >
              {cardPage.items.map(({ node }, pageIndex) => (
                <li
                  key={node.cardId}
                  className="rounded-lg border bg-background p-3"
                  data-semantic-card-row="true"
                  onFocusCapture={() => {
                    focusedCardRowRef.current = {
                      cardId: node.cardId,
                      pageIndex,
                    };
                  }}
                >
                  <p className="min-w-0 text-sm">
                    <span className="font-mono text-xs font-semibold text-accent-foreground">
                      {node.displayLabel}
                    </span>{' '}
                    <span className="font-medium">{node.title}</span>
                    {node.current && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        現在のカード
                      </span>
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="connections-semantic-action"
                      onClick={() => openCard(node.cardId)}
                    >
                      {node.displayLabel}を開く
                    </button>
                    <button
                      type="button"
                      className="connections-semantic-action"
                      disabled={!canMoveToMap}
                      onClick={() => moveToMap(node.cardId)}
                    >
                      {node.displayLabel}へマップ移動
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="connections-edge-list-heading">
            <h2
              id="connections-edge-list-heading"
              className="font-heading text-lg font-semibold"
            >
              参照一覧
            </h2>
            <label className="mt-3 block text-xs font-medium text-muted-foreground">
              始点・終点のカード番号・タイトルを検索
              <span className="mt-1 flex items-center gap-2 rounded-lg border bg-background px-3">
                <Search aria-hidden="true" className="size-4 shrink-0" />
                <input
                  type="search"
                  className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                  value={edgeQuery}
                  onChange={(event) => {
                    setEdgeQuery(event.currentTarget.value);
                    setEdgePageNumber(1);
                  }}
                />
              </span>
            </label>
            <div className="mt-3 grid gap-2">
              <PageStatus label="参照一覧" page={edgePage} />
              <PageControls
                label="参照一覧"
                page={edgePage}
                setPage={setEdgePageNumber}
              />
            </div>
            <ol
              className="mt-3 grid gap-2"
              aria-label="検索された参照一覧"
              start={edgePage.rangeStart || 1}
            >
              {edgePage.items.map(({ edge, source, target }) => (
                <li
                  key={`${edge.sourceCardId}->${edge.targetCardId}`}
                  className="rounded-lg border bg-background p-3"
                  aria-label={edge.accessibleName}
                >
                  <p className="text-sm">
                    <span className="font-medium">
                      {source.displayLabel} {source.title}
                    </span>{' '}
                    <span aria-hidden="true">→</span>
                    <span className="sr-only">から</span>{' '}
                    <span className="font-medium">
                      {target.displayLabel} {target.title}
                    </span>
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="connections-semantic-action"
                      onClick={() => openCard(source.cardId)}
                    >
                      始点 {source.displayLabel}を開く
                    </button>
                    <button
                      type="button"
                      className="connections-semantic-action"
                      onClick={() => openCard(target.cardId)}
                    >
                      終点 {target.displayLabel}を開く
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <button
            type="button"
            className="connections-semantic-action justify-self-start lg:col-span-2"
            onClick={close}
          >
            <X aria-hidden="true" className="size-4" />
            一覧を閉じる
          </button>
        </div>
      )}
    </details>
  );
}
