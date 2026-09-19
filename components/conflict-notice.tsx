'use client';

import { AlertTriangle, LoaderCircle, X } from 'lucide-react';
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
  const pending = model.resolutionState === 'pending';
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
          <div className="flex items-start justify-between gap-3">
            <p className="pt-2 font-semibold">変更が競合しました</p>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="min-h-11 min-w-11 shrink-0"
              aria-label="現在の入力を残して競合案を破棄"
              title="現在の入力を残して競合案を破棄"
              disabled={pending}
              onClick={() => onResolve('current')}
            >
              {pending ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <X aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="conflict-notice-muted mt-1 text-xs leading-5">
            {model.resolutionState === 'pending'
              ? '選んだ内容で競合を解決しています。入力内容は端末に保存されています。'
              : model.resolutionState === 'failed'
                ? '競合を同期できませんでした。内容は端末に残っています。案を選び直すか同期を再試行してください。'
                : 'どちらも保持されています。案を選ぶか、×で現在の入力を残してください。'}
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
                  disabled={pending}
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
