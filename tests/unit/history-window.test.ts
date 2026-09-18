import { describe, expect, it } from 'vitest';
import {
  captureHistoryAnchor,
  centeredHistoryScrollTop,
  historyTotalHeight,
  historyWindowLayout,
  moveHistoryFocus,
  restoreHistoryAnchorScrollTop,
  selectHistoryWindow,
} from '@/lib/application/history-window';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('history window', () => {
  it('represents an empty history without a render range', () => {
    expect(selectHistoryWindow(0, null, { kind: 'unmeasured' })).toEqual({
      kind: 'empty',
      totalHeight: 0,
      start: 0,
      endExclusive: 0,
      offsetTop: 0,
    });
  });

  it('bounds the unmeasured first render and includes the current item', () => {
    expect(
      selectHistoryWindow(10_000, null, { kind: 'unmeasured' }),
    ).toMatchObject({
      kind: 'windowed',
      start: 0,
      endExclusive: 12,
    });
    expect(
      selectHistoryWindow(10_000, 5_000, { kind: 'unmeasured' }),
    ).toMatchObject({
      kind: 'windowed',
      start: 4_992,
      endExclusive: 5_008,
      offsetTop: 12 + 4_992 * 120,
    });
    expect(
      selectHistoryWindow(10_000, 9_999, { kind: 'unmeasured' }),
    ).toMatchObject({
      kind: 'windowed',
      start: 9_988,
      endExclusive: 10_000,
    });
  });

  it('selects measured top, middle and bottom windows with bounded overscan', () => {
    expect(
      selectHistoryWindow(10_000, null, {
        kind: 'measured',
        scrollTop: 0,
        height: 480,
      }),
    ).toMatchObject({ start: 0, endExclusive: 8, offsetTop: 12 });
    expect(
      selectHistoryWindow(10_000, null, {
        kind: 'measured',
        scrollTop: 12 + 5_000 * 120,
        height: 480,
      }),
    ).toMatchObject({
      start: 4_996,
      endExclusive: 5_008,
      offsetTop: 12 + 4_996 * 120,
    });
    expect(
      selectHistoryWindow(10_000, null, {
        kind: 'measured',
        scrollTop: historyTotalHeight(10_000) - 480,
        height: 480,
      }),
    ).toMatchObject({ start: 9_992, endExclusive: 10_000 });
  });

  it('uses the fixed row contract for total height and centered scroll', () => {
    expect(historyWindowLayout).toEqual({
      rowHeight: 108,
      rowGap: 12,
      contentPadding: 12,
      overscanRows: 4,
      unmeasuredVisibleRows: 8,
    });
    expect(historyTotalHeight(3)).toBe(372);
    expect(centeredHistoryScrollTop(50, 100, 480)).toBe(5_826);
    expect(centeredHistoryScrollTop(0, 100, 480)).toBe(0);
    expect(centeredHistoryScrollTop(99, 100, 480)).toBe(11_532);
  });

  it('clamps invalid external measurements and focus movement', () => {
    expect(
      selectHistoryWindow(4.9, 99, {
        kind: 'measured',
        scrollTop: Number.NaN,
        height: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({ start: 0, endExclusive: 4 });
    expect(centeredHistoryScrollTop(Number.NaN, 4, Number.NaN)).toBe(0);
    expect(moveHistoryFocus(2, 4, 'previous')).toBe(1);
    expect(moveHistoryFocus(2, 4, 'next')).toBe(3);
    expect(moveHistoryFocus(2, 4, 'first')).toBe(0);
    expect(moveHistoryFocus(2, 4, 'last')).toBe(3);
    expect(moveHistoryFocus(3, 4, 'next')).toBe(3);
    expect(moveHistoryFocus(0, 4, 'previous')).toBe(0);
    expect(moveHistoryFocus(0, 0, 'last')).toBeNull();
  });

  it('restores an ID anchor across insertion and falls back near a removed row', () => {
    const currentCardId = fixtureCardId('history-anchor-current');
    const itemIds = ['a', 'b', 'c', 'd'].map((label) =>
      fixtureCardId(`history-anchor-${label}`),
    );
    const captured = captureHistoryAnchor(
      itemIds,
      currentCardId,
      historyWindowLayout.contentPadding + 2 * 120 + 23,
    );
    expect(captured).toEqual({
      currentCardId,
      anchorCardId: itemIds[2],
      fallbackIndex: 2,
      offsetPx: 23,
    });
    if (!captured) return;
    const prepended = [fixtureCardId('history-anchor-new'), ...itemIds];
    expect(restoreHistoryAnchorScrollTop(captured, prepended, 200)).toBe(
      historyWindowLayout.contentPadding + 3 * 120 + 23,
    );
    expect(
      restoreHistoryAnchorScrollTop(
        captured,
        prepended.filter((itemId) => itemId !== captured.anchorCardId),
        200,
      ),
    ).toBe(historyWindowLayout.contentPadding + 2 * 120 + 23);
    expect(captureHistoryAnchor([], currentCardId, 100)).toBeNull();
    expect(restoreHistoryAnchorScrollTop(captured, [], 200)).toBe(0);
  });
});
