import { ArrowRight } from 'lucide-react';
import { useMemo } from 'react';
import type { CardId } from '@/lib/domain/id';
import type { HistoryAnchor } from '@/lib/application/history-window';
import type { ViewStateSlot } from '@/lib/application/notes-view-state';
import type { HistoryViewModel } from '@/lib/application/presentation';
import {
  historyWindowLayout,
  type HistoryFocusMovement,
} from '@/lib/application/history-window';
import { useHistoryWindow } from '@/components/use-history-window';

type Props = {
  model: HistoryViewModel;
  onOpenCard: (cardId: CardId) => void;
  position: ViewStateSlot<HistoryAnchor>;
};

export function HistoryView({ model, onOpenCard, position }: Props) {
  const itemIds = useMemo(
    () => model.items.map((item) => item.cardId),
    [model.items],
  );
  const currentIndex = model.currentCardId
    ? model.items.findIndex((item) => item.cardId === model.currentCardId)
    : -1;
  const {
    window,
    registerScrollContainer,
    registerItem,
    updateFromScroll,
    moveFocus,
  } = useHistoryWindow(
    itemIds,
    model.currentCardId,
    currentIndex === -1 ? null : currentIndex,
    position,
  );
  const visibleItems = model.items.slice(window.start, window.endExclusive);
  const rowExtent = historyWindowLayout.rowHeight + historyWindowLayout.rowGap;

  const historyMovement = (key: string): HistoryFocusMovement | null => {
    switch (key) {
      case 'ArrowUp':
        return 'previous';
      case 'ArrowDown':
        return 'next';
      case 'Home':
        return 'first';
      case 'End':
        return 'last';
      default:
        return null;
    }
  };

  return (
    <section
      className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col"
      aria-label="過去のカード"
    >
      <div
        ref={registerScrollContainer}
        className="history-stack min-h-0 flex-1 overflow-y-auto rounded-2xl border bg-card/45"
        data-testid="history-list"
        data-history-total-count={model.items.length}
        data-history-window-start={window.start}
        data-history-window-end={window.endExclusive}
        data-history-render-count={visibleItems.length}
        data-history-row-height={historyWindowLayout.rowHeight}
        data-history-row-gap={historyWindowLayout.rowGap}
        data-history-overscan={historyWindowLayout.overscanRows}
        onScroll={(event) => updateFromScroll(event.currentTarget)}
      >
        <ol
          aria-label="過去のカード一覧"
          className="relative"
          style={{ height: `${window.totalHeight}px` }}
        >
          {visibleItems.map((item, visibleIndex) => {
            const itemIndex = window.start + visibleIndex;
            return (
              <li
                key={item.cardId}
                aria-posinset={itemIndex + 1}
                aria-setsize={model.items.length}
                className="absolute left-3 right-3 h-[108px]"
                style={{
                  top: `${window.offsetTop + visibleIndex * rowExtent}px`,
                }}
              >
                <button
                  ref={(element) => {
                    registerItem(itemIndex, element);
                  }}
                  type="button"
                  aria-current={item.current ? 'page' : undefined}
                  data-card-id={item.cardId}
                  data-display-value={item.displayValue}
                  data-current={item.current ? 'true' : 'false'}
                  onClick={() => onOpenCard(item.cardId)}
                  onKeyDown={(event) => {
                    const movement = historyMovement(event.key);
                    if (!movement) return;
                    event.preventDefault();
                    moveFocus(itemIndex, movement);
                  }}
                  className="group grid h-full w-full grid-cols-[auto_1fr_auto] items-start gap-4 overflow-hidden rounded-xl border bg-card px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring sm:px-5"
                >
                  <span className="pt-0.5 font-mono text-xs font-semibold text-accent-foreground">
                    {item.displayLabel}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-heading text-lg font-semibold">
                      {item.title}
                    </span>
                    <span className="mt-1 block line-clamp-2 text-sm leading-6 text-muted-foreground">
                      {item.preview}
                    </span>
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="mt-1 size-4 text-muted-foreground transition group-hover:translate-x-1"
                  />
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
