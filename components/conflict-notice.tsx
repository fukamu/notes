'use client';

import { Button } from '@/components/ui/button';
import type {
  ConflictChoice,
  ConflictViewModel,
} from '@/lib/application/presentation';

type Props = {
  model: ConflictViewModel;
  onResolve: (choice: ConflictChoice) => void;
};

export function ConflictNotice({ model, onResolve }: Props) {
  return (
    <aside className="conflict-notice" role="alert">
      <h2>別の端末の編集と重なりました</h2>
      <p className="conflict-notice-muted">
        どちらも保持されています。残したい内容を選んでください。
      </p>
      <div className="c2-conflict-options">
        {model.options.map((option) => (
          <section key={option.choice} className="conflict-notice-option">
            <div>
              <p className="c2-conflict-option-heading">{option.heading}</p>
              <p className="c2-conflict-title">{option.title}</p>
              <p className="conflict-notice-preview">{option.preview}</p>
            </div>
            <Button
              className="h-11 self-start rounded-md px-4 focus-visible:ring-2"
              variant="outline"
              aria-label={option.accessibleName}
              onClick={() => onResolve(option.choice)}
            >
              この案を使う
            </Button>
          </section>
        ))}
      </div>
    </aside>
  );
}
