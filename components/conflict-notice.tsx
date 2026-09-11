'use client';

import { AlertTriangle } from 'lucide-react';
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
    <aside
      className="conflict-notice mb-5 rounded-xl border p-4 text-sm"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="conflict-notice-icon mt-0.5 size-5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">別の端末の編集と重なりました</p>
          <p className="conflict-notice-muted mt-1 text-xs leading-5">
            どちらも保持されています。残したい内容を選んでください。
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {model.options.map((option) => (
              <div
                key={option.choice}
                className="conflict-notice-option rounded-lg p-3"
              >
                <p className="text-xs font-semibold">{option.heading}</p>
                <p className="mt-1 truncate font-heading font-semibold">
                  {option.title}
                </p>
                <p className="conflict-notice-preview mt-1 line-clamp-2 text-xs">
                  {option.preview}
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant={option.choice === 'server' ? 'outline' : 'default'}
                  aria-label={option.accessibleName}
                  onClick={() => onResolve(option.choice)}
                >
                  この案を使う
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
