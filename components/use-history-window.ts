'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  captureHistoryAnchor,
  centeredHistoryScrollTop,
  moveHistoryFocus,
  restoreHistoryAnchorScrollTop,
  selectHistoryWindow,
  type HistoryFocusMovement,
  type HistoryViewport,
  type HistoryWindow,
} from '@/lib/application/history-window';
import type { ViewStateSlot } from '@/lib/application/notes-view-state';
import type { HistoryAnchor } from '@/lib/application/history-window';
import type { CardId } from '@/lib/domain/id';

type HistoryWindowAdapter = Readonly<{
  window: HistoryWindow;
  registerScrollContainer: (element: HTMLDivElement | null) => void;
  registerItem: (index: number, element: HTMLButtonElement | null) => void;
  updateFromScroll: (element: HTMLDivElement) => void;
  moveFocus: (currentIndex: number, movement: HistoryFocusMovement) => void;
}>;

const unmeasuredViewport: HistoryViewport = { kind: 'unmeasured' };

function measuredViewport(element: HTMLDivElement): HistoryViewport | null {
  const height = element.clientHeight;
  const scrollTop = element.scrollTop;
  if (!Number.isFinite(height) || height <= 0) return null;
  return {
    kind: 'measured',
    height,
    scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
  };
}

function sameViewport(
  current: HistoryViewport,
  next: HistoryViewport,
): boolean {
  return (
    current.kind === 'measured' &&
    next.kind === 'measured' &&
    current.height === next.height &&
    current.scrollTop === next.scrollTop
  );
}

export function useHistoryWindow(
  itemIds: readonly CardId[],
  currentCardId: CardId | null,
  currentIndex: number | null,
  position: ViewStateSlot<HistoryAnchor>,
): HistoryWindowAdapter {
  const itemCount = itemIds.length;
  const [viewport, setViewport] = useState<HistoryViewport>(unmeasuredViewport);
  const scrollContainer = useRef<HTMLDivElement | null>(null);
  const itemElements = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocusIndex = useRef<number | null>(null);
  const window = useMemo(
    () => selectHistoryWindow(itemCount, currentIndex, viewport),
    [currentIndex, itemCount, viewport],
  );

  const setMeasuredViewport = useCallback((next: HistoryViewport) => {
    setViewport((current) => (sameViewport(current, next) ? current : next));
  }, []);

  const registerScrollContainer = useCallback(
    (element: HTMLDivElement | null) => {
      scrollContainer.current = element;
    },
    [],
  );

  const registerItem = useCallback(
    (index: number, element: HTMLButtonElement | null) => {
      if (element) itemElements.current.set(index, element);
      else itemElements.current.delete(index);
    },
    [],
  );

  const capturePosition = useCallback(
    (element: HTMLDivElement) => {
      if (currentCardId === null) return;
      const anchor = captureHistoryAnchor(
        itemIds,
        currentCardId,
        element.scrollTop,
      );
      if (anchor) position.write(anchor);
    },
    [currentCardId, itemIds, position],
  );

  const updateFromScroll = useCallback(
    (element: HTMLDivElement) => {
      capturePosition(element);
      const next = measuredViewport(element);
      if (next) setMeasuredViewport(next);
    },
    [capturePosition, setMeasuredViewport],
  );

  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;

    const restorePosition = () => {
      const measured = measuredViewport(container);
      if (!measured || measured.kind !== 'measured') return;
      const anchor = currentCardId === null ? null : position.read();
      const nextScrollTop =
        anchor && anchor.currentCardId === currentCardId
          ? restoreHistoryAnchorScrollTop(anchor, itemIds, measured.height)
          : currentIndex === null
            ? measured.scrollTop
            : centeredHistoryScrollTop(
                currentIndex,
                itemCount,
                measured.height,
              );
      container.scrollTop = nextScrollTop;
      setMeasuredViewport({
        kind: 'measured',
        height: measured.height,
        scrollTop: nextScrollTop,
      });
    };

    restorePosition();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(restorePosition);
    observer.observe(container);
    return () => {
      capturePosition(container);
      observer.disconnect();
    };
  }, [
    capturePosition,
    currentCardId,
    currentIndex,
    itemCount,
    itemIds,
    position,
    setMeasuredViewport,
  ]);

  useLayoutEffect(() => {
    const target = pendingFocusIndex.current;
    if (target === null) return;
    const element = itemElements.current.get(target);
    if (!element) return;
    pendingFocusIndex.current = null;
    element.focus();
  }, [window.endExclusive, window.start]);

  useLayoutEffect(
    () => () => {
      itemElements.current.clear();
      pendingFocusIndex.current = null;
      scrollContainer.current = null;
    },
    [],
  );

  const moveFocus = useCallback(
    (focusedIndex: number, movement: HistoryFocusMovement) => {
      const targetIndex = moveHistoryFocus(focusedIndex, itemCount, movement);
      if (targetIndex === null) return;
      const mountedTarget = itemElements.current.get(targetIndex);
      if (mountedTarget) {
        mountedTarget.focus();
        return;
      }

      const container = scrollContainer.current;
      const measured = container ? measuredViewport(container) : null;
      if (!container || !measured || measured.kind !== 'measured') return;
      pendingFocusIndex.current = targetIndex;
      const nextScrollTop = centeredHistoryScrollTop(
        targetIndex,
        itemCount,
        measured.height,
      );
      container.scrollTop = nextScrollTop;
      capturePosition(container);
      setMeasuredViewport({
        kind: 'measured',
        height: measured.height,
        scrollTop: nextScrollTop,
      });
    },
    [capturePosition, itemCount, setMeasuredViewport],
  );

  return {
    window,
    registerScrollContainer,
    registerItem,
    updateFromScroll,
    moveFocus,
  };
}
