'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ConnectionsReadyNode } from '@/lib/graph/connections-contract';
import {
  connectionsCenterPosition,
  type ConnectionsViewportPadding,
} from '@/lib/graph/connections-viewport';

export function useConnectionsViewport(
  currentNode: ConnectionsReadyNode | null,
  padding: ConnectionsViewportPadding,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const center = useCallback(
    (
      node: ConnectionsReadyNode | null,
      viewportPadding: ConnectionsViewportPadding,
    ) => {
      const viewport = viewportRef.current;
      const position = connectionsCenterPosition({
        viewport: viewport
          ? { width: viewport.clientWidth, height: viewport.clientHeight }
          : null,
        node,
        padding: viewportPadding,
      });
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (!viewport || !position) return;
      frameRef.current = window.requestAnimationFrame(() => {
        viewport.scrollTo({ ...position, behavior: 'auto' });
        frameRef.current = null;
      });
    },
    [],
  );

  useLayoutEffect(() => {
    center(currentNode, padding);
  }, [center, currentNode, padding]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => center(currentNode, padding));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [center, currentNode, padding]);

  useLayoutEffect(
    () => () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  return viewportRef;
}
