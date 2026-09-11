'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CardId } from '@/lib/domain/id';

type CurrentHistoryItemRefs = {
  registerScrollContainer: (element: HTMLDivElement | null) => void;
  registerCurrentItem: (element: HTMLButtonElement | null) => void;
};

export function useCurrentHistoryItem(
  currentCardId: CardId | null,
): CurrentHistoryItemRefs {
  const scrollContainer = useRef<HTMLDivElement | null>(null);
  const currentElement = useRef<HTMLButtonElement | null>(null);
  const registerScrollContainer = useCallback(
    (element: HTMLDivElement | null) => {
      scrollContainer.current = element;
    },
    [],
  );
  const registerCurrentElement = useCallback(
    (element: HTMLButtonElement | null) => {
      currentElement.current = element;
    },
    [],
  );

  useLayoutEffect(() => {
    const container = scrollContainer.current;
    const current = currentElement.current;
    if (!container || !current) return;

    const containerRect = container.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    const centeredTop =
      container.scrollTop +
      currentRect.top -
      containerRect.top -
      (container.clientHeight - currentRect.height) / 2;

    container.scrollTop = Math.max(0, centeredTop);
  }, [currentCardId]);

  return {
    registerScrollContainer,
    registerCurrentItem: registerCurrentElement,
  };
}
