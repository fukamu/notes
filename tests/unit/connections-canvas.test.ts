import { describe, expect, it } from 'vitest';
import { createConnectionsCanvasArrow } from '@/lib/graph/connections-canvas';

describe('connections Canvas geometry', () => {
  it('reproduces the previous SVG marker dimensions on a horizontal line', () => {
    expect(
      createConnectionsCanvasArrow({
        kind: 'line',
        start: { x: 0, y: 10 },
        end: { x: 10, y: 10 },
      }),
    ).toEqual({
      tip: { x: 11.4, y: 10 },
      baseBefore: { x: -2.5999999999999996, y: 17 },
      baseAfter: { x: -2.5999999999999996, y: 3 },
    });
  });

  it('uses the terminal quadratic tangent and keeps the arrow opaque geometry separate', () => {
    expect(
      createConnectionsCanvasArrow({
        kind: 'quadratic',
        start: { x: 0, y: 0 },
        control: { x: 10, y: 0 },
        end: { x: 10, y: 10 },
      }),
    ).toEqual({
      tip: { x: 10, y: 11.4 },
      baseBefore: { x: 3, y: -2.5999999999999996 },
      baseAfter: { x: 17, y: -2.5999999999999996 },
    });
  });

  it('rejects a collapsed terminal tangent', () => {
    expect(() =>
      createConnectionsCanvasArrow({
        kind: 'line',
        start: { x: 1, y: 1 },
        end: { x: 1, y: 1 },
      }),
    ).toThrow('finite terminal tangent');
  });
});
