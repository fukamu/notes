import { describe, expect, it } from 'vitest';
import {
  cardEditorInputVisibilityAdjustment,
  placeCardEditorCandidatePopover,
  type EditorViewportRect,
} from '@/lib/editor/card-editor-viewport';

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): EditorViewportRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

const base = {
  editor: rect(100, 100, 600, 800),
  visible: rect(40, 80, 800, 600),
  obstructions: [],
  popup: { width: 384, height: 240 },
  maximumWidth: 384,
  maximumHeight: 272,
  gap: 8,
  margin: 8,
} as const;

describe('card editor viewport placement', () => {
  it('places the candidate popup below a visible caret in document coordinates', () => {
    expect(
      placeCardEditorCandidatePopover({
        ...base,
        caret: rect(240, 220, 1, 24),
      }),
    ).toEqual({
      left: 240,
      top: 252,
      width: 384,
      maxHeight: 272,
      side: 'below',
    });
  });

  it('flips above near the bottom and constrains height to available space', () => {
    expect(
      placeCardEditorCandidatePopover({
        ...base,
        caret: rect(240, 620, 1, 24),
      }),
    ).toEqual({
      left: 240,
      top: 372,
      width: 384,
      maxHeight: 272,
      side: 'above',
    });
  });

  it('clamps horizontal placement and honors an offset visual viewport', () => {
    const visible = rect(500, 900, 320, 400);
    const placement = placeCardEditorCandidatePopover({
      ...base,
      editor: rect(480, 920, 500, 600),
      visible,
      caret: rect(810, 1_000, 1, 24),
    });
    expect(placement).toMatchObject({
      left: 508,
      top: 1_032,
      width: 304,
      side: 'below',
    });
  });

  it('uses actual top and bottom obstructions when choosing space', () => {
    const placement = placeCardEditorCandidatePopover({
      ...base,
      caret: rect(240, 390, 1, 24),
      obstructions: [rect(40, 80, 800, 72), rect(40, 612, 800, 68)],
    });
    expect(placement).toMatchObject({
      top: 160,
      maxHeight: 222,
      side: 'above',
    });
  });

  it('hides the popup while the caret is outside the usable viewport', () => {
    expect(
      placeCardEditorCandidatePopover({
        ...base,
        caret: rect(240, 40, 1, 24),
      }),
    ).toBeNull();
  });

  it('returns only the vertical document adjustment still required', () => {
    const visible = rect(0, 100, 400, 400);
    expect(
      cardEditorInputVisibilityAdjustment({
        target: rect(20, 470, 1, 48),
        visible,
        obstructions: [rect(0, 460, 400, 40)],
        gap: 8,
      }),
    ).toBe(66);
    expect(
      cardEditorInputVisibilityAdjustment({
        target: rect(20, 90, 100, 32),
        visible,
        obstructions: [],
        gap: 8,
      }),
    ).toBe(-10);
    expect(
      cardEditorInputVisibilityAdjustment({
        target: rect(20, 200, 100, 32),
        visible,
        obstructions: [],
        gap: 8,
      }),
    ).toBe(0);
  });
});
