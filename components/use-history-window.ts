'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  centeredHistoryScrollTop,
  moveHistoryFocus,
  selectHistoryWindow,
  type HistoryFocusMovement,
  type HistoryViewport,
  type HistoryWindow,
} from '@/lib/application/history-window';

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
  itemCount: number,
  currentIndex: number | null,
): HistoryWindowAdapter {
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

  const updateFromScroll = useCallback(
    (element: HTMLDivElement) => {
      const next = measuredViewport(element);
      if (next) setMeasuredViewport(next);
    },
    [setMeasuredViewport],
  );

  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;

    const centerCurrent = () => {
      const measured = measuredViewport(container);
      if (!measured || measured.kind !== 'measured') return;
      const nextScrollTop =
        currentIndex === null
          ? measured.scrollTop
          : centeredHistoryScrollTop(currentIndex, itemCount, measured.height);
      container.scrollTop = nextScrollTop;
      setMeasuredViewport({
        kind: 'measured',
        height: measured.height,
        scrollTop: nextScrollTop,
      });
    };

    centerCurrent();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(centerCurrent);
    observer.observe(container);
    return () => observer.disconnect();
  }, [currentIndex, itemCount, setMeasuredViewport]);

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
      setMeasuredViewport({
        kind: 'measured',
        height: measured.height,
        scrollTop: nextScrollTop,
      });
    },
    [itemCount, setMeasuredViewport],
  );

  return {
    window,
    registerScrollContainer,
    registerItem,
    updateFromScroll,
    moveFocus,
  };
}
