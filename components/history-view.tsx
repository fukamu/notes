'use client';

import { useLayoutEffect, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { bodyToPlainText } from '@/lib/domain/body';
import { formatDisplayId, sortCardsByDisplayId } from '@/lib/domain/display-id';
import type { CardId } from '@/lib/domain/id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';

type Props = {
  cards: CardRecord[];
  currentCardId: CardId | null;
  onSelect: (cardId: CardId) => void;
};

export function HistoryView({ cards, currentCardId, onSelect }: Props) {
  const currentRef = useRef<HTMLButtonElement>(null);
  const ordered = sortCardsByDisplayId(cards);

  useLayoutEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, [currentCardId]);

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
          番号順に、前後のカードをめくれます。
        </p>
      </div>
      <div
        className="history-stack max-h-[calc(100dvh-14rem)] space-y-3 overflow-y-auto rounded-2xl border bg-card/45 p-3 sm:p-5"
        data-testid="history-list"
      >
        {ordered.map((card) => {
          const current = card.id === currentCardId;
          const preview = bodyToPlainText(card.body, cards)
            .replace(/\s+/g, ' ')
            .trim();
          return (
            <button
              key={card.id}
              ref={current ? currentRef : undefined}
              type="button"
              data-card-id={card.id}
              data-display-value={card.displayId.value}
              data-current={current ? 'true' : 'false'}
              onClick={() => onSelect(card.id)}
              className="group grid w-full grid-cols-[auto_1fr_auto] items-start gap-4 rounded-xl border bg-card px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring sm:px-5"
            >
              <span className="pt-0.5 font-mono text-xs font-semibold text-accent-foreground">
                {formatDisplayId(card.displayId)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-heading text-lg font-semibold">
                  {visibleTitle(card.title)}
                </span>
                <span className="mt-1 block line-clamp-2 text-sm leading-6 text-muted-foreground">
                  {preview || '本文はまだありません'}
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
