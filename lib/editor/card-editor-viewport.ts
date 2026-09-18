export type EditorViewportRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

export type CandidatePopoverPlacement = Readonly<{
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: 'above' | 'below';
}>;

type CandidatePopoverPlacementInput = Readonly<{
  caret: EditorViewportRect;
  editor: EditorViewportRect;
  visible: EditorViewportRect;
  obstructions: readonly EditorViewportRect[];
  popup: Readonly<{ width: number; height: number }>;
  maximumWidth: number;
  maximumHeight: number;
  gap: number;
  margin: number;
}>;

const finite = (value: number) => Number.isFinite(value);

function validRect(rect: EditorViewportRect): boolean {
  return (
    [
      rect.left,
      rect.top,
      rect.right,
      rect.bottom,
      rect.width,
      rect.height,
    ].every(finite) &&
    rect.right >= rect.left &&
    rect.bottom >= rect.top &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function overlapsHorizontally(
  rect: EditorViewportRect,
  left: number,
  right: number,
): boolean {
  return rect.right > left && rect.left < right;
}

function verticalBounds(
  visible: EditorViewportRect,
  obstructions: readonly EditorViewportRect[],
  left: number,
  right: number,
  margin: number,
  gap: number,
): Readonly<{ top: number; bottom: number }> {
  let top = visible.top + margin;
  let bottom = visible.bottom - margin;
  for (const obstruction of obstructions) {
    if (
      !validRect(obstruction) ||
      !overlapsHorizontally(obstruction, left, right) ||
      obstruction.bottom <= visible.top ||
      obstruction.top >= visible.bottom
    ) {
      continue;
    }
    if (obstruction.top <= visible.top + margin) {
      top = Math.max(top, obstruction.bottom + gap);
    }
    if (obstruction.bottom >= visible.bottom - margin - gap) {
      bottom = Math.min(bottom, obstruction.top - gap);
    }
  }
  return { top, bottom };
}

export function placeCardEditorCandidatePopover(
  input: CandidatePopoverPlacementInput,
): CandidatePopoverPlacement | null {
  const {
    caret,
    editor,
    visible,
    obstructions,
    popup,
    maximumWidth,
    maximumHeight,
    gap,
    margin,
  } = input;
  if (
    !validRect(caret) ||
    !validRect(editor) ||
    !validRect(visible) ||
    ![
      popup.width,
      popup.height,
      maximumWidth,
      maximumHeight,
      gap,
      margin,
    ].every(finite) ||
    visible.width <= margin * 2 ||
    visible.height <= margin * 2 ||
    editor.width <= 0 ||
    maximumWidth <= 0 ||
    maximumHeight <= 0 ||
    popup.height <= 0 ||
    gap < 0 ||
    margin < 0
  ) {
    return null;
  }
  const width = Math.min(
    maximumWidth,
    editor.width,
    visible.width - margin * 2,
  );
  if (width <= 0) return null;
  const left = Math.min(
    Math.max(caret.left, visible.left + margin),
    visible.right - margin - width,
  );
  const bounds = verticalBounds(
    visible,
    obstructions,
    left,
    left + width,
    margin,
    gap,
  );
  if (
    caret.right < visible.left ||
    caret.left > visible.right ||
    caret.bottom < bounds.top ||
    caret.top > bounds.bottom ||
    bounds.bottom <= bounds.top
  ) {
    return null;
  }
  const below = Math.max(0, bounds.bottom - (caret.bottom + gap));
  const above = Math.max(0, caret.top - gap - bounds.top);
  if (below <= 0 && above <= 0) return null;
  const desiredHeight = Math.min(maximumHeight, popup.height);
  const side =
    below >= desiredHeight || (below > 0 && below >= above) ? 'below' : 'above';
  const available = side === 'below' ? below : above;
  const maxHeight = Math.min(maximumHeight, available);
  if (maxHeight <= 0) return null;
  return {
    left,
    top:
      side === 'below'
        ? caret.bottom + gap
        : caret.top - gap - Math.min(popup.height, maxHeight),
    width,
    maxHeight,
    side,
  };
}

type InputVisibilityAdjustmentInput = Readonly<{
  target: EditorViewportRect;
  visible: EditorViewportRect;
  obstructions: readonly EditorViewportRect[];
  gap: number;
}>;

export function cardEditorInputVisibilityAdjustment(
  input: InputVisibilityAdjustmentInput,
): number {
  const { target, visible, obstructions, gap } = input;
  if (!validRect(target) || !validRect(visible) || !finite(gap) || gap < 0) {
    return 0;
  }
  const bounds = verticalBounds(
    visible,
    obstructions,
    target.left,
    target.right,
    0,
    gap,
  );
  if (target.bottom > bounds.bottom) return target.bottom - bounds.bottom;
  if (target.top < bounds.top) return target.top - bounds.top;
  return 0;
}
