import { describe, expect, it, vi } from 'vitest';
import { createConnectionsCanvasRasterCache } from '@/lib/client/connections-canvas-raster-cache';

type FakeContext = CanvasRenderingContext2D & {
  drawImage: ReturnType<typeof vi.fn>;
};

function fakeCanvas() {
  const setTransform = vi.fn();
  const context = {
    imageSmoothingEnabled: false,
    setTransform,
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as FakeContext;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, context, setTransform };
}

describe('connections bounded Canvas raster cache', () => {
  it('renders into one bounded surface, reuses covered movement, and swaps one back surface', () => {
    const destination = fakeCanvas();
    const first = fakeCanvas();
    const second = fakeCanvas();
    const surfaces = [first.canvas, second.canvas];
    const cache = createConnectionsCanvasRasterCache(() => {
      const surface = surfaces.shift();
      if (!surface) throw new Error('Unexpected third raster surface');
      return surface;
    });
    const revision = [{}] as const;
    const render = vi.fn((_input: unknown) => 20_000);
    const base = {
      destination: destination.canvas,
      camera: { x: 10, y: 20, scale: 0.5 },
      viewport: { width: 100, height: 50 },
      devicePixelRatio: 2,
      overscanPx: 20,
      revision,
      render,
    } as const;

    expect(cache.paint(base)).toMatchObject({
      status: 'painted',
      strategy: 'refresh',
      scaled: false,
      itemCount: 20_000,
      cachePixelWidth: 280,
      cachePixelHeight: 180,
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(first.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0);
    expect(render.mock.calls[0]?.[0]).toMatchObject({
      camera: { x: 30, y: 40, scale: 0.5 },
      viewport: { width: 140, height: 90 },
    });

    expect(
      cache.paint({
        ...base,
        camera: { ...base.camera, x: 30 },
      }),
    ).toMatchObject({
      status: 'painted',
      strategy: 'reuse',
      scaled: false,
    });
    expect(render).toHaveBeenCalledTimes(1);

    expect(
      cache.paint({
        ...base,
        camera: { ...base.camera, x: 31 },
      }),
    ).toMatchObject({ status: 'painted', strategy: 'refresh' });
    expect(render).toHaveBeenCalledTimes(2);
    expect(surfaces).toHaveLength(0);

    expect(cache.paint({ ...base, revision: [{}] })).toMatchObject({
      status: 'painted',
      strategy: 'refresh',
    });
    expect(render).toHaveBeenCalledTimes(3);
    expect(surfaces).toHaveLength(0);

    cache.reset();
    expect(first.canvas.width).toBe(0);
    expect(second.canvas.width).toBe(0);
  });

  it('temporarily scales a compatible frame and force-refreshes the exact scale', () => {
    const destination = fakeCanvas();
    const first = fakeCanvas();
    const second = fakeCanvas();
    const surfaces = [first.canvas, second.canvas];
    const cache = createConnectionsCanvasRasterCache(() => {
      const surface = surfaces.shift();
      if (!surface) throw new Error('Unexpected third raster surface');
      return surface;
    });
    const render = vi.fn(() => 10);
    const base = {
      destination: destination.canvas,
      camera: { x: 10, y: 20, scale: 0.5 },
      viewport: { width: 100, height: 50 },
      devicePixelRatio: 1,
      overscanPx: 20,
      revision: ['layout', 'theme'],
      render,
    } as const;
    cache.paint(base);
    expect(
      cache.paint({
        ...base,
        camera: { x: -6, y: 8, scale: 0.6 },
      }),
    ).toMatchObject({
      status: 'painted',
      strategy: 'reuse',
      scaled: true,
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      cache.paint({
        ...base,
        camera: { x: -6, y: 8, scale: 0.6 },
        forceRefresh: true,
      }),
    ).toMatchObject({
      status: 'painted',
      strategy: 'refresh',
      scaled: false,
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(surfaces).toHaveLength(0);
  });
});
