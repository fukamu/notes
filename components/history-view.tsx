import { ArrowRight } from 'lucide-react';
import type { CardId } from '@/lib/domain/id';
import type { HistoryViewModel } from '@/lib/application/presentation';
import { useCurrentHistoryItem } from '@/components/use-current-history-item';

type Props = {
  model: HistoryViewModel;
  onOpenCard: (cardId: CardId) => void;
};

export function HistoryView({ model, onOpenCard }: Props) {
  const { registerScrollContainer, registerCurrentItem } =
    useCurrentHistoryItem(model.currentCardId);

  return (
    <section
      className="mx-auto w-full max-w-3xl"
      aria-labelledby="history-heading"
    >
      <div className="mb-5">
        <p className="eyebrow">CARD STACK</p>
        <h1
          id="history-heading"
          className="font-heading text-2xl font-semibold"
        >
          過去のカード
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          新しい番号から、前後のカードをめくれます。
        </p>
      </div>
      <div
        ref={registerScrollContainer}
        className="history-stack max-h-[calc(100dvh-18.25rem)] space-y-3 overflow-y-auto rounded-2xl border bg-card/45 p-3 sm:p-5 lg:max-h-[calc(100dvh-14rem)]"
        data-testid="history-list"
      >
        {model.items.map((item) => {
          return (
            <button
              key={item.cardId}
              ref={item.current ? registerCurrentItem : undefined}
              type="button"
              aria-current={item.current ? 'page' : undefined}
              data-card-id={item.cardId}
              data-display-value={item.displayValue}
              data-current={item.current ? 'true' : 'false'}
              onClick={() => onOpenCard(item.cardId)}
              className="group grid w-full grid-cols-[auto_1fr_auto] items-start gap-4 rounded-xl border bg-card px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring sm:px-5"
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
          );
        })}
      </div>
    </section>
  );
}
