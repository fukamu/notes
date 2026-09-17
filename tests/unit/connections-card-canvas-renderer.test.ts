import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionsCanvasCardRenderer } from '@/lib/client/connections-card-canvas-renderer';
import { parseCardId } from '@/lib/domain/id';
import type { ConnectionsReadyNode } from '@/lib/graph/connections-contract';

function node(index: number, current = false): ConnectionsReadyNode {
  return {
    cardId: parseCardId(
      `00000000-0000-7000-8000-${index.toString().padStart(12, '0')}`,
    ),
    displayLabel: `#${index}`,
    title: `card ${index}`,
    accessibleName: `#${index} card ${index}`,
    current,
    x: index * 120,
    y: 20,
    width: 100,
    height: 60,
    ports: [],
  };
}

describe('connections Canvas card renderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws every visible non-retained card and highlights the current card', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14);
    const operations: string[] = [];
    const context = {
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: () => operations.push('begin'),
      roundRect: (x: number) => operations.push(`card:${x}`),
      fill() {
        operations.push(`fill:${this.fillStyle}:${this.globalAlpha}`);
      },
      stroke() {
        operations.push(
          `stroke:${this.strokeStyle}:${this.lineWidth}:${this.globalAlpha}`,
        );
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const renderer = createConnectionsCanvasCardRenderer();

    expect(
      renderer.paint({
        canvas,
        nodes: [node(1), node(2, true), node(3)],
        visibleNodeIndices: [0, 1, 2],
        excludedNodeIndex: 2,
        camera: { x: 4, y: 5, scale: 0.25 },
        viewport: { width: 100, height: 50 },
        devicePixelRatio: 2,
        colors: { fill: 'card', border: 'border', current: 'primary' },
      }),
    ).toMatchObject({ status: 'painted', nodeCount: 2, durationMs: 4 });
    expect(operations).toEqual([
      'begin',
      'card:120',
      'fill:card:1',
      'stroke:border:1:1',
      'begin',
      'card:240',
      'fill:card:1',
      'fill:primary:0.18',
      'stroke:primary:12:1',
    ]);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(context.setTransform).toHaveBeenLastCalledWith(
      0.5,
      0,
      0,
      0.5,
      8,
      10,
    );
  });

  it('clears stale overview pixels once when HTML mode resumes', () => {
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const renderer = createConnectionsCanvasCardRenderer();
    const input = {
      canvas,
      viewport: { width: 100, height: 50 },
      devicePixelRatio: 1,
    } as const;

    expect(renderer.clear(input)).toMatchObject({ status: 'cleared' });
    expect(renderer.clear(input)).toMatchObject({ status: 'cleared' });
    expect(context.clearRect).toHaveBeenCalledTimes(1);
  });

  it('reuses overview card pixels while the viewport remains inside overscan', () => {
    const destinationContext = {
      imageSmoothingEnabled: false,
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    };
    const destination = {
      width: 0,
      height: 0,
      getContext: () => destinationContext,
    } as unknown as HTMLCanvasElement;
    const surfaceOperations: string[] = [];
    const surfaceContext = {
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      roundRect: (x: number) => surfaceOperations.push(`card:${x}`),
      fill: vi.fn(),
      stroke: vi.fn(),
    };
    const surface = {
      width: 0,
      height: 0,
      getContext: () => surfaceContext,
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: () => surface });
    const renderer = createConnectionsCanvasCardRenderer();
    const base = {
      canvas: destination,
      nodes: [node(1), node(2)],
      visibleNodeIndices: [0, 1],
      excludedNodeIndex: null,
      camera: { x: 4, y: 5, scale: 0.25 },
      viewport: { width: 100, height: 50 },
      devicePixelRatio: 1,
      colors: { fill: 'card', border: 'border', current: 'primary' },
      mode: 'bounded-cache',
    } as const;

    expect(renderer.paint(base)).toMatchObject({
      status: 'painted',
      strategy: 'raster-refresh',
      nodeCount: 2,
    });
    expect(surfaceOperations).toEqual(['card:120', 'card:240']);
    expect(
      renderer.paint({ ...base, camera: { ...base.camera, y: 69 } }),
    ).toMatchObject({
      status: 'painted',
      strategy: 'raster-reuse',
    });
    expect(surfaceOperations).toEqual(['card:120', 'card:240']);
    expect(destinationContext.drawImage).toHaveBeenCalledTimes(2);

    renderer.reset();
    expect(surface.width).toBe(0);
  });
});
