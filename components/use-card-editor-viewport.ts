'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import {
  cardEditorInputVisibilityAdjustment,
  placeCardEditorCandidatePopover,
  type CandidatePopoverPlacement,
  type EditorViewportRect,
} from '@/lib/editor/card-editor-viewport';

const POPOVER_MAX_WIDTH = 384;
const POPOVER_MAX_HEIGHT = 272;
const VIEWPORT_GAP = 8;
const VIEWPORT_MARGIN = 8;

type FocusedEditorInput = 'title' | 'body' | null;

type ClientRectLike = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width?: number;
  height?: number;
}>;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function documentRect(rect: ClientRectLike): EditorViewportRect | null {
  const width = rect.width ?? rect.right - rect.left;
  const height = rect.height ?? rect.bottom - rect.top;
  const values = [
    rect.left,
    rect.top,
    rect.right,
    rect.bottom,
    width,
    height,
    window.scrollX,
    window.scrollY,
  ];
  if (!values.every(finite)) return null;
  return {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    right: rect.right + window.scrollX,
    bottom: rect.bottom + window.scrollY,
    width,
    height,
  };
}

function visibleDocumentRect(): EditorViewportRect | null {
  const viewport = window.visualViewport;
  const left = viewport?.pageLeft ?? window.scrollX;
  const top = viewport?.pageTop ?? window.scrollY;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  if (![left, top, width, height].every(finite) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function obstructionRects(): readonly EditorViewportRect[] {
  const visible = visibleDocumentRect();
  if (!visible) return [];
  const elements = document.querySelectorAll<HTMLElement>(
    '.notes-shell > header, .app-navigation',
  );
  return [...elements]
    .map((element) => documentRect(element.getBoundingClientRect()))
    .filter(
      (rect): rect is EditorViewportRect =>
        rect !== null &&
        rect.right > visible.left &&
        rect.left < visible.right &&
        rect.bottom > visible.top &&
        rect.top < visible.bottom,
    );
}

function samePlacement(
  current: CandidatePopoverPlacement | null,
  next: CandidatePopoverPlacement | null,
): boolean {
  if (current === null || next === null) return current === next;
  return (
    current.left === next.left &&
    current.top === next.top &&
    current.width === next.width &&
    current.maxHeight === next.maxHeight &&
    current.side === next.side
  );
}

export function useCardEditorCandidatePopover(
  editor: Editor | null,
  open: boolean,
  popoverRef: RefObject<HTMLDivElement | null>,
): CandidatePopoverPlacement | null {
  const [placement, setPlacement] = useState<CandidatePopoverPlacement | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !editor || editor.isDestroyed) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const popup = popoverRef.current;
      const visible = visibleDocumentRect();
      if (!popup || !visible || editor.isDestroyed) {
        setPlacement((current) => (current === null ? current : null));
        return;
      }
      let caretClientRect: ClientRectLike;
      try {
        caretClientRect = editor.view.coordsAtPos(editor.state.selection.from);
      } catch {
        setPlacement((current) => (current === null ? current : null));
        return;
      }
      const caret = documentRect(caretClientRect);
      const editorRect = documentRect(editor.view.dom.getBoundingClientRect());
      const popupRect = popup.getBoundingClientRect();
      const next =
        caret && editorRect
          ? placeCardEditorCandidatePopover({
              caret,
              editor: editorRect,
              visible,
              obstructions: obstructionRects(),
              popup: { width: popupRect.width, height: popupRect.height },
              maximumWidth: POPOVER_MAX_WIDTH,
              maximumHeight: POPOVER_MAX_HEIGHT,
              gap: VIEWPORT_GAP,
              margin: VIEWPORT_MARGIN,
            })
          : null;
      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    editor.on('selectionUpdate', schedule);
    editor.on('transaction', schedule);
    document.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', schedule, { passive: true });
    const viewport = window.visualViewport;
    viewport?.addEventListener('scroll', schedule, { passive: true });
    viewport?.addEventListener('resize', schedule, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(editor.view.dom);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    for (const element of document.querySelectorAll<HTMLElement>(
      '.notes-shell > header, .app-navigation',
    )) {
      observer?.observe(element);
    }
    return () => {
      editor.off('selectionUpdate', schedule);
      editor.off('transaction', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      viewport?.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor, open, popoverRef]);

  return open ? placement : null;
}

export function useCardEditorInputVisibility(
  editor: Editor | null,
  focusedInput: FocusedEditorInput,
  titleInputRef: RefObject<HTMLInputElement | null>,
): Readonly<{
  bottomPadding: number;
  requestVisibility: () => void;
  startComposition: () => void;
  endComposition: () => void;
}> {
  const editorRef = useRef(editor);
  const focusedInputRef = useRef(focusedInput);
  const composingRef = useRef(false);
  const pendingAfterCompositionRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const focusScaleRef = useRef<number | null>(null);
  const [bottomPadding, setBottomPadding] = useState(0);
  const bottomPaddingRef = useRef(0);

  const updateBottomPadding = useCallback((next: number) => {
    if (bottomPaddingRef.current === next) return false;
    bottomPaddingRef.current = next;
    setBottomPadding(next);
    return true;
  }, []);

  useLayoutEffect(() => {
    editorRef.current = editor;
    focusedInputRef.current = focusedInput;
    focusScaleRef.current =
      focusedInput === null ? null : (window.visualViewport?.scale ?? 1);
    if (focusedInput === null) {
      composingRef.current = false;
      pendingAfterCompositionRef.current = false;
      bottomPaddingRef.current = 0;
      const frame = window.requestAnimationFrame(() => setBottomPadding(0));
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [editor, focusedInput]);

  const focusedTarget = useCallback((): EditorViewportRect | null => {
    const focused = focusedInputRef.current;
    const currentEditor = editorRef.current;
    if (!focused || composingRef.current) return null;
    if (focused === 'title') {
      const input = titleInputRef.current;
      if (input && document.activeElement === input) {
        return documentRect(input.getBoundingClientRect());
      }
      return null;
    }
    if (
      currentEditor &&
      !currentEditor.isDestroyed &&
      currentEditor.isFocused
    ) {
      try {
        return documentRect(
          currentEditor.view.coordsAtPos(currentEditor.state.selection.from),
        );
      } catch {
        return null;
      }
    }
    return null;
  }, [titleInputRef]);

  const scrollFocusedInputIntoView = useCallback(() => {
    const target = focusedTarget();
    const visible = visibleDocumentRect();
    if (!target || !visible) return;
    const obstructions = obstructionRects();
    const delta = cardEditorInputVisibilityAdjustment({
      target,
      visible,
      obstructions,
      gap: VIEWPORT_GAP,
    });
    if (Math.abs(delta) <= 1) return;
    const scrollingElement = document.scrollingElement;
    if (!scrollingElement) return;
    const maximum = Math.max(
      0,
      scrollingElement.scrollHeight - scrollingElement.clientHeight,
    );
    const next = Math.min(Math.max(0, window.scrollY + delta), maximum);
    if (Math.abs(next - window.scrollY) <= 1) return;
    window.scrollTo({ top: next, behavior: 'auto' });
  }, [focusedTarget]);

  const measureAndAdjust = useCallback(() => {
    frameRef.current = null;
    const target = focusedTarget();
    if (!target) return;
    const visible = visibleDocumentRect();
    if (!visible) return;
    const obstructions = obstructionRects();
    const viewport = window.visualViewport;
    const sameScale =
      !viewport ||
      focusScaleRef.current === null ||
      Math.abs(viewport.scale - focusScaleRef.current) < 0.001;
    const coveredHeight =
      viewport && sameScale
        ? Math.max(
            0,
            window.scrollY +
              window.innerHeight -
              (viewport.pageTop + viewport.height),
          )
        : 0;
    const overlappingBottomNavigation = Math.max(
      0,
      ...obstructions.map((rect) =>
        rect.bottom >= visible.bottom - VIEWPORT_GAP
          ? Math.min(rect.bottom, visible.bottom) -
            Math.max(rect.top, visible.top)
          : 0,
      ),
    );
    const requiredAdjustment = cardEditorInputVisibilityAdjustment({
      target,
      visible,
      obstructions,
      gap: VIEWPORT_GAP,
    });
    const scrollingElement = document.scrollingElement;
    const remainingScroll = scrollingElement
      ? Math.max(
          0,
          scrollingElement.scrollHeight -
            scrollingElement.clientHeight -
            window.scrollY,
        )
      : 0;
    const unavailableAdjustment = Math.max(
      0,
      requiredAdjustment - remainingScroll,
    );
    const retainedNavigationPadding =
      bottomPaddingRef.current > 0 && overlappingBottomNavigation > 0
        ? Math.min(
            bottomPaddingRef.current,
            Math.ceil(overlappingBottomNavigation + VIEWPORT_GAP),
          )
        : 0;
    const nextPadding =
      coveredHeight > 1
        ? Math.ceil(coveredHeight + overlappingBottomNavigation + VIEWPORT_GAP)
        : unavailableAdjustment > 1
          ? Math.ceil(unavailableAdjustment + VIEWPORT_GAP)
          : retainedNavigationPadding;
    if (updateBottomPadding(nextPadding)) {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          scrollFocusedInputIntoView();
        });
      });
      return;
    }
    scrollFocusedInputIntoView();
  }, [focusedTarget, scrollFocusedInputIntoView, updateBottomPadding]);

  const requestVisibility = useCallback(() => {
    if (composingRef.current) {
      pendingAfterCompositionRef.current = true;
      return;
    }
    if (frameRef.current !== null)
      window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = window.requestAnimationFrame(measureAndAdjust);
    });
  }, [measureAndAdjust]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || focusedInput === null) return;
    let previousHeight = viewport.height;
    let previousScale = viewport.scale;
    const handleResize = () => {
      const height = viewport.height;
      const scale = viewport.scale;
      const scaleChanged = Math.abs(scale - previousScale) >= 0.001;
      const heightChanged = Math.abs(height - previousHeight) > 1;
      previousHeight = height;
      previousScale = scale;
      if (!scaleChanged && heightChanged) requestVisibility();
    };
    viewport.addEventListener('resize', handleResize, { passive: true });
    return () => viewport.removeEventListener('resize', handleResize);
  }, [focusedInput, requestVisibility]);

  useEffect(
    () => () => {
      if (frameRef.current !== null)
        window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return {
    bottomPadding,
    requestVisibility,
    startComposition: () => {
      composingRef.current = true;
    },
    endComposition: () => {
      composingRef.current = false;
      if (pendingAfterCompositionRef.current) {
        pendingAfterCompositionRef.current = false;
      }
      requestVisibility();
    },
  };
}
