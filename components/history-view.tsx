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
    <section className="c2-history" aria-labelledby="history-heading">
      <div className="c2-history-heading">
        <h1 id="history-heading">過去のカード</h1>
        <p>新しい番号から、前後のカードをめくれます。</p>
      </div>
      <div
        ref={registerScrollContainer}
        className="history-stack c2-history-list"
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
              className="c2-history-row"
            >
              <span className="c2-history-meta">
                <span>{item.displayLabel}</span>
                {item.current && <span className="c2-current-label">現在</span>}
              </span>
              <span className="c2-history-copy">
                <span className="c2-history-title">{item.title}</span>
                <span className="c2-history-preview">{item.preview}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
