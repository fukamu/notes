'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bodyToPlainText } from '@/lib/domain/body';
import {
  visibleTitle,
  type CardRecord,
  type ConflictRecord,
} from '@/lib/domain/types';

type Props = {
  conflict: ConflictRecord;
  cards: CardRecord[];
  onResolve: (choice: 'local' | 'server') => void;
};

export function ConflictNotice({ conflict, cards, onResolve }: Props) {
  return (
    <aside
      className="mb-5 rounded-xl border border-amber-500/35 bg-amber-50/80 p-4 text-sm text-amber-950"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-amber-700"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">別の端末の編集と重なりました</p>
          <p className="mt-1 text-xs leading-5 text-amber-900/75">
            どちらも保持されています。残したい内容を選んでください。
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-white/70 p-3">
              <p className="text-xs font-semibold">編集案 A</p>
              <p className="mt-1 truncate font-heading font-semibold">
                {visibleTitle(conflict.localTitle)}
              </p>
              <p className="mt-1 line-clamp-2 text-xs text-amber-950/70">
                {bodyToPlainText(conflict.localBody, cards) || '本文なし'}
              </p>
              <Button
                className="mt-3"
                size="sm"
                aria-label={`編集案「${visibleTitle(conflict.localTitle)}」を使う`}
                onClick={() => onResolve('local')}
              >
                この案を使う
              </Button>
            </div>
            <div className="rounded-lg bg-white/70 p-3">
              <p className="text-xs font-semibold">編集案 B</p>
              <p className="mt-1 truncate font-heading font-semibold">
                {visibleTitle(conflict.serverTitle)}
              </p>
              <p className="mt-1 line-clamp-2 text-xs text-amber-950/70">
                {bodyToPlainText(conflict.serverBody, cards) || '本文なし'}
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                aria-label={`編集案「${visibleTitle(conflict.serverTitle)}」を使う`}
                onClick={() => onResolve('server')}
              >
                この案を使う
              </Button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
