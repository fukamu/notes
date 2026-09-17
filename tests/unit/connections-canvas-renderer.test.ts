import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionsCanvasEdgeRenderer } from '@/lib/client/connections-canvas-renderer';
import { prepareConnectionsVisibility } from '@/lib/graph/connections-visibility';

class FakePath2D {
  static constructions = 0;

  constructor(_path?: string) {
    FakePath2D.constructions += 1;
  }

  moveTo() {}
  lineTo() {}
  closePath() {}
}

function fixture() {
  return prepareConnectionsVisibility(
    [],
    [
      {
        id: 'first',
        sections: [
          {
            id: 'first-section',
            startPoint: { x: 0, y: 10 },
            bendPoints: [],
            endPoint: { x: 20, y: 10 },
          },
        ],
      },
      {
        id: 'second',
        sections: [
          {
            id: 'second-section',
            startPoint: { x: 0, y: 20 },
            bendPoints: [],
            endPoint: { x: 20, y: 20 },
          },
        ],
      },
    ],
    { x: 0, y: 0, width: 40, height: 40 },
    { maximumRadius: 16, nodeClearance: 32 },
  );
}

describe('connections Canvas edge renderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakePath2D.constructions = 0;
  });

  it('caches paths by geometry and paints halo, stroke, then opaque arrow in edge order', () => {
    vi.stubGlobal('Path2D', FakePath2D);
    const operations: string[] = [];
    const context = {
      globalAlpha: 1,
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 0,
      lineCap: 'butt',
      lineJoin: 'miter',
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      stroke() {
        operations.push(
          `stroke:${this.strokeStyle}:${this.lineWidth}:${this.globalAlpha}`,
        );
      },
      fill() {
        operations.push(`fill:${this.fillStyle}:${this.globalAlpha}`);
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const prepared = fixture();
    const renderer = createConnectionsCanvasEdgeRenderer();
    const input = {
      canvas,
      prepared,
      visibleEdgeIndices: [0, 1],
      camera: { x: 4, y: 5, scale: 0.5 },
      viewport: { width: 100, height: 50 },
      devicePixelRatio: 2,
      colors: { halo: 'white', stroke: 'blue' },
    } as const;

    expect(renderer.paint(input)).toMatchObject({
      status: 'painted',
      edgeCount: 2,
    });
    expect(operations).toEqual([
      'stroke:white:8:1',
      'stroke:blue:2:0.72',
      'fill:blue:1',
      'stroke:white:8:1',
      'stroke:blue:2:0.72',
      'fill:blue:1',
    ]);
    expect(FakePath2D.constructions).toBe(4);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(context.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 8, 10);

    operations.length = 0;
    renderer.paint(input);
    expect(FakePath2D.constructions).toBe(4);
  });

  it('settles as unavailable when Canvas has no 2D context', () => {
    vi.stubGlobal('Path2D', FakePath2D);
    const renderer = createConnectionsCanvasEdgeRenderer();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(
      renderer.paint({
        canvas,
        prepared: fixture(),
        visibleEdgeIndices: [0],
        camera: { x: 0, y: 0, scale: 1 },
        viewport: { width: 100, height: 50 },
        devicePixelRatio: 1,
        colors: { halo: 'white', stroke: 'blue' },
      }),
    ).toEqual({ status: 'unavailable', reason: 'context' });
  });
});
