import { describe, expect, it } from 'vitest';
import { resolveConnectionsRasterPlacement } from '@/lib/graph/connections-raster-cache';

describe('connections raster cache geometry', () => {
  const capture = {
    camera: { x: 10, y: 20, scale: 0.5 },
    viewport: { width: 100, height: 50 },
    overscanPx: 20,
  } as const;

  it('places the capture at negative overscan and covers bounded pans', () => {
    expect(resolveConnectionsRasterPlacement(capture, capture.camera)).toEqual({
      covered: true,
      scaled: false,
      scaleRatio: 1,
      x: -20,
      y: -20,
      width: 140,
      height: 90,
    });
    expect(
      resolveConnectionsRasterPlacement(capture, {
        ...capture.camera,
        x: 30,
      })?.covered,
    ).toBe(true);
    expect(
      resolveConnectionsRasterPlacement(capture, {
        ...capture.camera,
        x: 31,
      })?.covered,
    ).toBe(false);
  });

  it('supports temporary scale reuse only while the capture covers the viewport', () => {
    const zoomed = resolveConnectionsRasterPlacement(capture, {
      x: -6,
      y: 8,
      scale: 0.6,
    });
    expect(zoomed).toMatchObject({
      covered: true,
      scaled: true,
      scaleRatio: 1.2,
    });
    expect(
      resolveConnectionsRasterPlacement(capture, {
        x: 44,
        y: 28,
        scale: 0.4,
      })?.covered,
    ).toBe(false);
  });

  it('rejects invalid capture or camera values', () => {
    expect(
      resolveConnectionsRasterPlacement(capture, {
        x: 0,
        y: 0,
        scale: Number.NaN,
      }),
    ).toBeNull();
    expect(
      resolveConnectionsRasterPlacement(
        { ...capture, overscanPx: -1 },
        capture.camera,
      ),
    ).toBeNull();
  });
});
