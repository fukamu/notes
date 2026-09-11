import { bodyToPlainText } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardId } from '@/lib/domain/id';
import {
  visibleTitle,
  type CardRecord,
  type ConflictRecord,
  type SaveState,
  type SyncState,
} from '@/lib/domain/types';
import type {
  ConflictChoice,
  ConflictOptionViewModel,
  ConflictViewModel,
  ConnectionsViewModel,
  HistoryViewModel,
  NotesStatusViewModel,
} from '@/lib/application/presentation';

export function selectNotesStatus(
  saveState: SaveState,
  syncState: SyncState,
): NotesStatusViewModel {
  if (saveState === 'failed') {
    return {
      kind: 'save-failed',
      label: '端末への保存に失敗',
      retryable: false,
    };
  }
  if (saveState === 'saving') {
    return { kind: 'saving', label: '保存中', retryable: false };
  }
  if (syncState === 'syncing') {
    return { kind: 'syncing', label: '同期中', retryable: false };
  }
  if (syncState === 'offline') {
    return {
      kind: 'offline',
      label: 'オフライン・端末に保存済み',
      retryable: false,
    };
  }
  if (syncState === 'failed') {
    return {
      kind: 'sync-failed',
      label: '同期失敗・端末に保存済み',
      retryable: true,
    };
  }
  return { kind: 'saved', label: '保存済み', retryable: false };
}

function compareHistoryCards(
  left: { card: CardRecord; sourceIndex: number },
  right: { card: CardRecord; sourceIndex: number },
): number {
  const byNumber = left.card.displayId.value - right.card.displayId.value;
  if (byNumber !== 0) return byNumber;
  if (left.card.displayId.kind !== right.card.displayId.kind) {
    return left.card.displayId.kind === 'official' ? -1 : 1;
  }
  const byCreatedAt = left.card.createdAt - right.card.createdAt;
  if (byCreatedAt !== 0) return byCreatedAt;
  const byId = left.card.id.localeCompare(right.card.id);
  return byId !== 0 ? byId : left.sourceIndex - right.sourceIndex;
}

export function selectHistoryViewModel(
  cards: CardRecord[],
  currentCardId: CardId | null,
): HistoryViewModel {
  const items = cards
    .map((card, sourceIndex) => ({ card, sourceIndex }))
    .sort(compareHistoryCards)
    .map(({ card }) => {
      const preview = bodyToPlainText(card.body, cards)
        .replace(/\s+/g, ' ')
        .trim();
      return {
        cardId: card.id,
        displayLabel: formatDisplayId(card.displayId),
        displayValue: card.displayId.value,
        title: visibleTitle(card.title),
        preview: preview || '本文はまだありません',
        current: card.id === currentCardId,
      };
    });

  return { currentCardId, items };
}

function conflictOption(
  choice: ConflictChoice,
  conflict: ConflictRecord,
  cards: CardRecord[],
): ConflictOptionViewModel {
  const local = choice === 'local';
  const title = visibleTitle(
    local ? conflict.localTitle : conflict.serverTitle,
  );
  const preview = bodyToPlainText(
    local ? conflict.localBody : conflict.serverBody,
    cards,
  );
  return {
    choice,
    heading: local ? '編集案 A' : '編集案 B',
    title,
    preview: preview || '本文なし',
    accessibleName: `編集案「${title}」を使う`,
  };
}

export function selectConflictViewModel(
  conflict: ConflictRecord,
  cards: CardRecord[],
): ConflictViewModel {
  return {
    conflictId: conflict.id,
    cardId: conflict.cardId,
    options: [
      conflictOption('local', conflict, cards),
      conflictOption('server', conflict, cards),
    ],
  };
}

export function selectConnectionsViewModel(
  cards: CardRecord[],
  currentCardId: CardId,
): ConnectionsViewModel {
  return {
    cards,
    currentCardId,
    graph: buildConnectionsGraph(cards),
  };
}
