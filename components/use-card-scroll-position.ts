'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CardScrollSnapshot } from '@/lib/application/notes-view-state';
import type { ViewStateSlot } from '@/lib/application/notes-view-state';
import type { NotesViewName } from '@/lib/application/presentation';
import type { CardId } from '@/lib/domain/id';

type CardScrollPositionController = Readonly<{
  captureBeforeViewChange: (nextView: NotesViewName) => void;
}>;

function readWindowScrollY(): number {
  return Number.isFinite(window.scrollY) ? Math.max(0, window.scrollY) : 0;
}

export function useCardScrollPosition(
  activeView: NotesViewName,
  currentCardId: CardId | null,
  position: ViewStateSlot<CardScrollSnapshot>,
): CardScrollPositionController {
  const activeViewRef = useRef(activeView);
  const currentCardIdRef = useRef(currentCardId);
  const positionRef = useRef(position);
  const previousViewRef = useRef(activeView);
  const requestTokenRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    activeViewRef.current = activeView;
    currentCardIdRef.current = currentCardId;
    positionRef.current = position;
  }, [activeView, currentCardId, position]);

  const capture = useCallback(() => {
    const cardId = currentCardIdRef.current;
    if (activeViewRef.current !== 'card' || cardId === null) return;
    positionRef.current.write({
      currentCardId: cardId,
      scrollY: readWindowScrollY(),
    });
  }, []);

  const captureBeforeViewChange = useCallback(
    (nextView: NotesViewName) => {
      if (nextView !== 'card') capture();
    },
    [capture],
  );

  useLayoutEffect(() => {
    if (activeView !== 'card' || currentCardId === null) return;
    const handleScroll = () => capture();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [activeView, capture, currentCardId]);

  useLayoutEffect(() => {
    const previousView = previousViewRef.current;
    previousViewRef.current = activeView;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    if (
      activeView !== 'card' ||
      previousView === 'card' ||
      currentCardId === null
    ) {
      return;
    }
    const snapshot = position.read();
    if (!snapshot || snapshot.currentCardId !== currentCardId) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (
        requestTokenRef.current !== token ||
        activeViewRef.current !== 'card' ||
        currentCardIdRef.current !== currentCardId
      ) {
        return;
      }
      const scrollingElement = document.scrollingElement;
      if (!scrollingElement) return;
      const maximum = Math.max(
        0,
        scrollingElement.scrollHeight - scrollingElement.clientHeight,
      );
      window.scrollTo({
        top: Math.min(Math.max(0, snapshot.scrollY), maximum),
        behavior: 'auto',
      });
    });
    return () => {
      requestTokenRef.current += 1;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [activeView, currentCardId, position]);

  useLayoutEffect(
    () => () => {
      requestTokenRef.current += 1;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    },
    [],
  );

  return { captureBeforeViewChange };
}
