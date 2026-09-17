import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';
import {
  resolveConnectionsRasterPlacement,
  type ConnectionsRasterCapture,
  type ConnectionsRasterViewport,
} from '@/lib/graph/connections-raster-cache';

type RasterRevisionPart = string | number | boolean | object | null;

type RasterFrame = Readonly<{
  canvas: HTMLCanvasElement;
  capture: ConnectionsRasterCapture;
  devicePixelRatio: number;
  revision: readonly RasterRevisionPart[];
  itemCount: number;
}>;

export type ConnectionsCanvasRasterPaintResult =
  | Readonly<{
      status: 'painted';
      strategy: 'refresh' | 'reuse';
      scaled: boolean;
      itemCount: number;
      durationMs: number;
      renderDurationMs: number;
      cachePixelWidth: number;
      cachePixelHeight: number;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'context' | 'render' | 'size' | 'surface';
    }>;

export type ConnectionsCanvasRasterCache = Readonly<{
  paint: (input: {
    destination: HTMLCanvasElement;
    camera: ConnectionsCamera;
    viewport: ConnectionsRasterViewport;
    devicePixelRatio: number;
    overscanPx: number;
    revision: readonly RasterRevisionPart[];
    forceRefresh?: boolean;
    render: (input: {
      canvas: HTMLCanvasElement;
      context: CanvasRenderingContext2D;
      camera: ConnectionsCamera;
      viewport: ConnectionsRasterViewport;
    }) => number;
  }) => ConnectionsCanvasRasterPaintResult;
  reset: () => void;
}>;

type CanvasFactory = () => HTMLCanvasElement;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function sameRevision(
  left: readonly RasterRevisionPart[],
  right: readonly RasterRevisionPart[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function readContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  devicePixelRatio: number,
) {
  const pixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
  const pixelHeight = Math.max(1, Math.round(height * devicePixelRatio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
}

function releaseCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

export function createConnectionsCanvasRasterCache(
  createCanvas: CanvasFactory = () => document.createElement('canvas'),
): ConnectionsCanvasRasterCache {
  let front: RasterFrame | null = null;
  let back: HTMLCanvasElement | null = null;

  const reset = () => {
    releaseCanvas(front?.canvas ?? null);
    if (back !== front?.canvas) releaseCanvas(back);
    front = null;
    back = null;
  };

  return {
    paint(input) {
      const started = performance.now();
      if (
        !finitePositive(input.viewport.width) ||
        !finitePositive(input.viewport.height) ||
        !finitePositive(input.devicePixelRatio) ||
        !Number.isFinite(input.overscanPx) ||
        input.overscanPx < 0
      ) {
        return { status: 'unavailable', reason: 'size' };
      }
      resizeCanvas(
        input.destination,
        input.viewport.width,
        input.viewport.height,
        input.devicePixelRatio,
      );
      const destinationContext = readContext(input.destination);
      if (!destinationContext) {
        return { status: 'unavailable', reason: 'context' };
      }

      const reusable =
        !input.forceRefresh &&
        front &&
        front.devicePixelRatio === input.devicePixelRatio &&
        front.capture.viewport.width === input.viewport.width &&
        front.capture.viewport.height === input.viewport.height &&
        front.capture.overscanPx === input.overscanPx &&
        sameRevision(front.revision, input.revision)
          ? resolveConnectionsRasterPlacement(front.capture, input.camera)
          : null;

      let strategy: 'refresh' | 'reuse' = 'reuse';
      let renderDurationMs = 0;
      if (!front || !reusable?.covered) {
        strategy = 'refresh';
        let surface: HTMLCanvasElement;
        try {
          surface = back ?? createCanvas();
        } catch {
          return { status: 'unavailable', reason: 'surface' };
        }
        const surfaceViewport = {
          width: input.viewport.width + input.overscanPx * 2,
          height: input.viewport.height + input.overscanPx * 2,
        };
        resizeCanvas(
          surface,
          surfaceViewport.width,
          surfaceViewport.height,
          input.devicePixelRatio,
        );
        const surfaceContext = readContext(surface);
        if (!surfaceContext) {
          return { status: 'unavailable', reason: 'surface' };
        }
        surfaceContext.setTransform(1, 0, 0, 1, 0, 0);
        surfaceContext.clearRect(0, 0, surface.width, surface.height);
        const renderStarted = performance.now();
        let itemCount: number;
        try {
          itemCount = input.render({
            canvas: surface,
            context: surfaceContext,
            camera: {
              x: input.camera.x + input.overscanPx,
              y: input.camera.y + input.overscanPx,
              scale: input.camera.scale,
            },
            viewport: surfaceViewport,
          });
        } catch {
          return { status: 'unavailable', reason: 'render' };
        }
        renderDurationMs = performance.now() - renderStarted;
        const previousFront = front;
        front = {
          canvas: surface,
          capture: {
            camera: input.camera,
            viewport: input.viewport,
            overscanPx: input.overscanPx,
          },
          devicePixelRatio: input.devicePixelRatio,
          revision: [...input.revision],
          itemCount,
        };
        back = previousFront?.canvas ?? null;
      }

      const placement = front
        ? resolveConnectionsRasterPlacement(front.capture, input.camera)
        : null;
      if (!front || !placement?.covered) {
        return { status: 'unavailable', reason: 'render' };
      }
      destinationContext.setTransform(1, 0, 0, 1, 0, 0);
      destinationContext.clearRect(
        0,
        0,
        input.destination.width,
        input.destination.height,
      );
      destinationContext.imageSmoothingEnabled = true;
      try {
        destinationContext.drawImage(
          front.canvas,
          placement.x * input.devicePixelRatio,
          placement.y * input.devicePixelRatio,
          front.canvas.width * placement.scaleRatio,
          front.canvas.height * placement.scaleRatio,
        );
      } catch {
        return { status: 'unavailable', reason: 'render' };
      }
      return {
        status: 'painted',
        strategy,
        scaled: placement.scaled,
        itemCount: front.itemCount,
        durationMs: performance.now() - started,
        renderDurationMs,
        cachePixelWidth: front.canvas.width,
        cachePixelHeight: front.canvas.height,
      };
    },
    reset,
  };
}
