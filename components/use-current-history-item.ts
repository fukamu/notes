'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CardId } from '@/lib/domain/id';

export function useCurrentHistoryItem(
  currentCardId: CardId | null,
): (element: HTMLButtonElement | null) => void {
  const currentElement = useRef<HTMLButtonElement | null>(null);
  const registerCurrentElement = useCallback(
    (element: HTMLButtonElement | null) => {
      currentElement.current = element;
    },
    [],
  );

  useLayoutEffect(() => {
    currentElement.current?.scrollIntoView({ block: 'center' });
  }, [currentCardId]);

  return registerCurrentElement;
}
