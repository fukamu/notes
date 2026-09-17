import type { ConnectionsReadyNode } from '@/lib/graph/connections-contract';
import { createConnectionsCanvasRasterCache } from '@/lib/client/connections-canvas-raster-cache';
import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';
import { CONNECTIONS_VISIBILITY_OVERSCAN_PX } from '@/lib/graph/connections-visibility';

export type ConnectionsCanvasCardColors = Readonly<{
  fill: string;
  border: string;
  current: string;
}>;

export type ConnectionsCanvasCardPaintResult =
  | Readonly<{
      status: 'painted';
      strategy:
        | 'direct'
        | 'direct-fallback'
        | 'raster-refresh'
        | 'raster-reuse';
      scaledRaster: boolean;
      nodeCount: number;
      durationMs: number;
      rasterRenderDurationMs: number;
      cachePixelWidth: number;
      cachePixelHeight: number;
    }>
  | Readonly<{
      status: 'cleared';
      nodeCount: 0;
      durationMs: number;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'context' | 'size';
    }>;

export type ConnectionsCanvasCardRenderer = Readonly<{
  paint: (input: {
    canvas: HTMLCanvasElement;
    nodes: readonly ConnectionsReadyNode[];
    visibleNodeIndices: readonly number[];
    excludedNodeIndex: number | null;
    camera: ConnectionsCamera;
    viewport: Readonly<{ width: number; height: number }>;
    devicePixelRatio: number;
    colors: ConnectionsCanvasCardColors;
    mode?: 'direct' | 'bounded-cache';
    forceRasterRefresh?: boolean;
  }) => ConnectionsCanvasCardPaintResult;
  clear: (input: {
    canvas: HTMLCanvasElement;
    viewport: Readonly<{ width: number; height: number }>;
    devicePixelRatio: number;
  }) => ConnectionsCanvasCardPaintResult;
  reset: () => void;
}>;

const cardRadius = 12;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  viewport: Readonly<{ width: number; height: number }>,
  devicePixelRatio: number,
): CanvasRenderingContext2D | null {
  if (
    !finitePositive(viewport.width) ||
    !finitePositive(viewport.height) ||
    !finitePositive(devicePixelRatio)
  ) {
    return null;
  }
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!context) return null;
  const pixelWidth = Math.max(1, Math.round(viewport.width * devicePixelRatio));
  const pixelHeight = Math.max(
    1,
    Math.round(viewport.height * devicePixelRatio),
  );
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return context;
}

function appendCardPath(
  context: CanvasRenderingContext2D,
  node: ConnectionsReadyNode,
) {
  context.roundRect(
    node.x,
    node.y,
    node.width,
    node.height,
    Math.min(cardRadius, node.width / 2, node.height / 2),
  );
}

function paintPreparedCards(
  context: CanvasRenderingContext2D,
  nodes: readonly ConnectionsReadyNode[],
  visibleNodeIndices: readonly number[],
  excludedNodeIndex: number | null,
  camera: ConnectionsCamera,
  devicePixelRatio: number,
  colors: ConnectionsCanvasCardColors,
): number {
  const scale = camera.scale * devicePixelRatio;
  context.setTransform(
    scale,
    0,
    0,
    scale,
    camera.x * devicePixelRatio,
    camera.y * devicePixelRatio,
  );
  const currentNodes: ConnectionsReadyNode[] = [];
  let nodeCount = 0;
  context.beginPath();
  for (const nodeIndex of visibleNodeIndices) {
    if (nodeIndex === excludedNodeIndex) continue;
    const node = nodes[nodeIndex];
    if (!node) continue;
    nodeCount += 1;
    if (node.current) {
      currentNodes.push(node);
      continue;
    }
    appendCardPath(context, node);
  }
  context.globalAlpha = 1;
  context.fillStyle = colors.fill;
  context.fill();
  context.strokeStyle = colors.border;
  context.lineWidth = 1;
  context.stroke();

  for (const node of currentNodes) {
    context.beginPath();
    appendCardPath(context, node);
    context.globalAlpha = 1;
    context.fillStyle = colors.fill;
    context.fill();
    context.globalAlpha = 0.18;
    context.fillStyle = colors.current;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = colors.current;
    context.lineWidth = 3 / camera.scale;
    context.stroke();
  }
  context.globalAlpha = 1;
  return nodeCount;
}

export function createConnectionsCanvasCardRenderer(): ConnectionsCanvasCardRenderer {
  let cleared = false;
  let rasterActive = false;
  const rasterCache = createConnectionsCanvasRasterCache();
  return {
    paint(input) {
      const context = prepareCanvas(
        input.canvas,
        input.viewport,
        input.devicePixelRatio,
      );
      if (!context || !finitePositive(input.camera.scale)) {
        return {
          status: 'unavailable',
          reason: context ? 'size' : 'context',
        };
      }
      const started = performance.now();
      const pixelWidth = input.canvas.width;
      const pixelHeight = input.canvas.height;
      const useRaster = input.mode === 'bounded-cache';
      if (useRaster) {
        rasterActive = true;
        const rasterResult = rasterCache.paint({
          destination: input.canvas,
          camera: input.camera,
          viewport: input.viewport,
          devicePixelRatio: input.devicePixelRatio,
          overscanPx: CONNECTIONS_VISIBILITY_OVERSCAN_PX,
          revision: [
            input.nodes,
            input.excludedNodeIndex ?? -1,
            input.colors.fill,
            input.colors.border,
            input.colors.current,
          ],
          ...(input.forceRasterRefresh === undefined
            ? {}
            : { forceRefresh: input.forceRasterRefresh }),
          render: ({ context, camera }) =>
            paintPreparedCards(
              context,
              input.nodes,
              input.visibleNodeIndices,
              input.excludedNodeIndex,
              camera,
              input.devicePixelRatio,
              input.colors,
            ),
        });
        if (rasterResult.status === 'painted') {
          cleared = false;
          return {
            status: 'painted',
            strategy:
              rasterResult.strategy === 'refresh'
                ? 'raster-refresh'
                : 'raster-reuse',
            scaledRaster: rasterResult.scaled,
            nodeCount: rasterResult.itemCount,
            durationMs: rasterResult.durationMs,
            rasterRenderDurationMs: rasterResult.renderDurationMs,
            cachePixelWidth: rasterResult.cachePixelWidth,
            cachePixelHeight: rasterResult.cachePixelHeight,
          };
        }
      } else if (rasterActive) {
        rasterCache.reset();
        rasterActive = false;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      const nodeCount = paintPreparedCards(
        context,
        input.nodes,
        input.visibleNodeIndices,
        input.excludedNodeIndex,
        input.camera,
        input.devicePixelRatio,
        input.colors,
      );
      cleared = false;
      return {
        status: 'painted',
        strategy: useRaster ? 'direct-fallback' : 'direct',
        scaledRaster: false,
        nodeCount,
        durationMs: performance.now() - started,
        rasterRenderDurationMs: 0,
        cachePixelWidth: 0,
        cachePixelHeight: 0,
      };
    },
    clear(input) {
      const context = prepareCanvas(
        input.canvas,
        input.viewport,
        input.devicePixelRatio,
      );
      if (!context) return { status: 'unavailable', reason: 'context' };
      const started = performance.now();
      if (rasterActive) {
        rasterCache.reset();
        rasterActive = false;
      }
      if (!cleared) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, input.canvas.width, input.canvas.height);
        cleared = true;
      }
      return {
        status: 'cleared',
        nodeCount: 0,
        durationMs: performance.now() - started,
      };
    },
    reset() {
      rasterCache.reset();
      rasterActive = false;
      cleared = false;
    },
  };
}
