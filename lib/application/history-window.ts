export const historyWindowLayout = Object.freeze({
  rowHeight: 108,
  rowGap: 12,
  contentPadding: 12,
  overscanRows: 4,
  unmeasuredVisibleRows: 8,
});

export type HistoryWindowLayout = Readonly<typeof historyWindowLayout>;

export type HistoryViewport =
  | Readonly<{ kind: 'unmeasured' }>
  | Readonly<{
      kind: 'measured';
      scrollTop: number;
      height: number;
    }>;

export type HistoryWindow =
  | Readonly<{
      kind: 'empty';
      totalHeight: 0;
      start: 0;
      endExclusive: 0;
      offsetTop: 0;
    }>
  | Readonly<{
      kind: 'windowed';
      totalHeight: number;
      start: number;
      endExclusive: number;
      offsetTop: number;
    }>;

export type HistoryFocusMovement = 'previous' | 'next' | 'first' | 'last';

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function wholeNonNegative(value: number): number {
  return Math.floor(finiteNonNegative(value));
}

function clampedItemIndex(index: number | null, itemCount: number): number {
  if (index === null || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), itemCount - 1);
}

function rowExtent(layout: HistoryWindowLayout): number {
  return layout.rowHeight + layout.rowGap;
}

export function historyTotalHeight(
  itemCount: number,
  layout: HistoryWindowLayout = historyWindowLayout,
): number {
  const count = wholeNonNegative(itemCount);
  if (count === 0) return 0;
  return layout.contentPadding * 2 + count * rowExtent(layout) - layout.rowGap;
}

export function selectHistoryWindow(
  itemCount: number,
  currentIndex: number | null,
  viewport: HistoryViewport,
  layout: HistoryWindowLayout = historyWindowLayout,
): HistoryWindow {
  const count = wholeNonNegative(itemCount);
  if (count === 0) {
    return {
      kind: 'empty',
      totalHeight: 0,
      start: 0,
      endExclusive: 0,
      offsetTop: 0,
    };
  }

  const extent = rowExtent(layout);
  const overscan = wholeNonNegative(layout.overscanRows);
  let visibleStart: number;
  let visibleEndExclusive: number;

  if (viewport.kind === 'unmeasured') {
    const visibleRows = Math.min(
      count,
      Math.max(1, wholeNonNegative(layout.unmeasuredVisibleRows)),
    );
    visibleStart = Math.min(
      Math.max(
        0,
        clampedItemIndex(currentIndex, count) - Math.floor(visibleRows / 2),
      ),
      count - visibleRows,
    );
    visibleEndExclusive = visibleStart + visibleRows;
  } else {
    const scrollTop = finiteNonNegative(viewport.scrollTop);
    const height = finiteNonNegative(viewport.height);
    const contentScrollTop = Math.max(0, scrollTop - layout.contentPadding);
    visibleStart = Math.min(count - 1, Math.floor(contentScrollTop / extent));
    visibleEndExclusive = Math.min(
      count,
      Math.max(
        visibleStart + 1,
        Math.ceil(
          Math.max(0, scrollTop + height - layout.contentPadding) / extent,
        ),
      ),
    );
  }

  const start = Math.max(0, visibleStart - overscan);
  const endExclusive = Math.min(count, visibleEndExclusive + overscan);
  return {
    kind: 'windowed',
    totalHeight: historyTotalHeight(count, layout),
    start,
    endExclusive,
    offsetTop: layout.contentPadding + start * extent,
  };
}

export function centeredHistoryScrollTop(
  itemIndex: number,
  itemCount: number,
  viewportHeight: number,
  layout: HistoryWindowLayout = historyWindowLayout,
): number {
  const count = wholeNonNegative(itemCount);
  if (count === 0) return 0;
  const index = clampedItemIndex(itemIndex, count);
  const height = finiteNonNegative(viewportHeight);
  if (height === 0) return 0;
  const desired =
    layout.contentPadding +
    index * rowExtent(layout) -
    (height - layout.rowHeight) / 2;
  return Math.min(
    Math.max(0, desired),
    Math.max(0, historyTotalHeight(count, layout) - height),
  );
}

export function moveHistoryFocus(
  currentIndex: number,
  itemCount: number,
  movement: HistoryFocusMovement,
): number | null {
  const count = wholeNonNegative(itemCount);
  if (count === 0) return null;
  const current = clampedItemIndex(currentIndex, count);
  switch (movement) {
    case 'previous':
      return Math.max(0, current - 1);
    case 'next':
      return Math.min(count - 1, current + 1);
    case 'first':
      return 0;
    case 'last':
      return count - 1;
  }
}
