import {
  CONNECTIONS_EDGE_HALO_WIDTH,
  CONNECTIONS_EDGE_STROKE_OPACITY,
  CONNECTIONS_EDGE_STROKE_WIDTH,
} from '@/lib/graph/connections-canvas';
import { createConnectionsCanvasRasterCache } from '@/lib/client/connections-canvas-raster-cache';
import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';
import type {
  PreparedConnectionsEdge,
  PreparedConnectionsVisibility,
} from '@/lib/graph/connections-visibility';
import { CONNECTIONS_VISIBILITY_OVERSCAN_PX } from '@/lib/graph/connections-visibility';

type ConnectionsCanvasColors = Readonly<{
  halo: string;
  stroke: string;
}>;

type PreparedCanvasSection = Readonly<{
  path: Path2D;
  arrow: Path2D | null;
}>;

type PreparedCanvasEdge = Readonly<{
  sections: readonly PreparedCanvasSection[];
}>;

type PreparedCanvasGeometry = Readonly<{
  source: PreparedConnectionsVisibility;
  edges: readonly PreparedCanvasEdge[];
}>;

export type ConnectionsCanvasPaintResult =
  | Readonly<{
      status: 'painted';
      strategy:
        | 'direct'
        | 'direct-fallback'
        | 'raster-refresh'
        | 'raster-reuse';
      scaledRaster: boolean;
      edgeCount: number;
      prepareDurationMs: number;
      durationMs: number;
      rasterRenderDurationMs: number;
      cachePixelWidth: number;
      cachePixelHeight: number;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'context' | 'path' | 'size';
    }>;

export type ConnectionsCanvasEdgeRenderer = Readonly<{
  paint: (input: {
    canvas: HTMLCanvasElement;
    prepared: PreparedConnectionsVisibility;
    visibleEdgeIndices: readonly number[];
    camera: ConnectionsCamera;
    viewport: Readonly<{ width: number; height: number }>;
    devicePixelRatio: number;
    colors: ConnectionsCanvasColors;
    mode?: 'direct' | 'bounded-cache';
    forceRasterRefresh?: boolean;
  }) => ConnectionsCanvasPaintResult;
  reset: () => void;
}>;

function createArrowPath(edge: PreparedConnectionsEdge, sectionIndex: number) {
  const section = edge.sections[sectionIndex];
  if (!section?.arrow) return null;
  const arrow = new Path2D();
  arrow.moveTo(section.arrow.baseBefore.x, section.arrow.baseBefore.y);
  arrow.lineTo(section.arrow.tip.x, section.arrow.tip.y);
  arrow.lineTo(section.arrow.baseAfter.x, section.arrow.baseAfter.y);
  arrow.closePath();
  return arrow;
}

function prepareCanvasGeometry(
  source: PreparedConnectionsVisibility,
): PreparedCanvasGeometry {
  return {
    source,
    edges: source.edges.map((edge) => ({
      sections: edge.sections.map((section, sectionIndex) => ({
        path: new Path2D(section.d),
        arrow: createArrowPath(edge, sectionIndex),
      })),
    })),
  };
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function paintPreparedEdges(
  context: CanvasRenderingContext2D,
  geometry: PreparedCanvasGeometry,
  edgeIndices: readonly number[],
  camera: ConnectionsCamera,
  devicePixelRatio: number,
  colors: ConnectionsCanvasColors,
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
  context.lineCap = 'round';
  context.lineJoin = 'round';
  let edgeCount = 0;
  for (const edgeIndex of edgeIndices) {
    const edge = geometry.edges[edgeIndex];
    if (!edge) continue;
    edgeCount += 1;
    for (const section of edge.sections) {
      context.globalAlpha = 1;
      context.strokeStyle = colors.halo;
      context.lineWidth = CONNECTIONS_EDGE_HALO_WIDTH;
      context.stroke(section.path);

      context.globalAlpha = CONNECTIONS_EDGE_STROKE_OPACITY;
      context.strokeStyle = colors.stroke;
      context.lineWidth = CONNECTIONS_EDGE_STROKE_WIDTH;
      context.stroke(section.path);

      if (section.arrow) {
        context.globalAlpha = 1;
        context.fillStyle = colors.stroke;
        context.fill(section.arrow);
      }
    }
  }
  context.globalAlpha = 1;
  return edgeCount;
}

export function createConnectionsCanvasEdgeRenderer(): ConnectionsCanvasEdgeRenderer {
  let geometry: PreparedCanvasGeometry | null = null;
  const rasterCache = createConnectionsCanvasRasterCache();
  let rasterActive = false;

  return {
    paint(input) {
      const prepareStarted = performance.now();
      const { canvas, viewport, camera } = input;
      if (
        !finitePositive(viewport.width) ||
        !finitePositive(viewport.height) ||
        !finitePositive(input.devicePixelRatio) ||
        !finitePositive(camera.scale) ||
        !Number.isFinite(camera.x) ||
        !Number.isFinite(camera.y)
      ) {
        return { status: 'unavailable', reason: 'size' };
      }
      let context: CanvasRenderingContext2D | null = null;
      try {
        context = canvas.getContext('2d');
      } catch {
        return { status: 'unavailable', reason: 'context' };
      }
      if (!context) return { status: 'unavailable', reason: 'context' };

      try {
        if (geometry?.source !== input.prepared) {
          geometry = prepareCanvasGeometry(input.prepared);
        }
      } catch {
        geometry = null;
        return { status: 'unavailable', reason: 'path' };
      }
      const prepareDurationMs = performance.now() - prepareStarted;

      const pixelWidth = Math.max(
        1,
        Math.round(viewport.width * input.devicePixelRatio),
      );
      const pixelHeight = Math.max(
        1,
        Math.round(viewport.height * input.devicePixelRatio),
      );
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const useRaster = input.mode === 'bounded-cache';
      if (useRaster) {
        rasterActive = true;
        const preparedGeometry = geometry;
        const rasterResult = rasterCache.paint({
          destination: canvas,
          camera,
          viewport,
          devicePixelRatio: input.devicePixelRatio,
          overscanPx: CONNECTIONS_VISIBILITY_OVERSCAN_PX,
          revision: [input.prepared, input.colors.halo, input.colors.stroke],
          ...(input.forceRasterRefresh === undefined
            ? {}
            : { forceRefresh: input.forceRasterRefresh }),
          render: ({ context, camera: renderCamera }) =>
            paintPreparedEdges(
              context,
              preparedGeometry,
              input.visibleEdgeIndices,
              renderCamera,
              input.devicePixelRatio,
              input.colors,
            ),
        });
        if (rasterResult.status === 'painted') {
          return {
            status: 'painted',
            strategy:
              rasterResult.strategy === 'refresh'
                ? 'raster-refresh'
                : 'raster-reuse',
            scaledRaster: rasterResult.scaled,
            edgeCount: rasterResult.itemCount,
            prepareDurationMs,
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
      const started = performance.now();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      const edgeCount = paintPreparedEdges(
        context,
        geometry,
        input.visibleEdgeIndices,
        camera,
        input.devicePixelRatio,
        input.colors,
      );
      return {
        status: 'painted',
        strategy: useRaster ? 'direct-fallback' : 'direct',
        scaledRaster: false,
        edgeCount,
        prepareDurationMs,
        durationMs: performance.now() - started,
        rasterRenderDurationMs: 0,
        cachePixelWidth: 0,
        cachePixelHeight: 0,
      };
    },
    reset() {
      geometry = null;
      rasterCache.reset();
      rasterActive = false;
    },
  };
}
