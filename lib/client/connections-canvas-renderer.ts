import {
  CONNECTIONS_EDGE_HALO_WIDTH,
  CONNECTIONS_EDGE_STROKE_OPACITY,
  CONNECTIONS_EDGE_STROKE_WIDTH,
} from '@/lib/graph/connections-canvas';
import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';
import type {
  PreparedConnectionsEdge,
  PreparedConnectionsVisibility,
} from '@/lib/graph/connections-visibility';

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
      edgeCount: number;
      prepareDurationMs: number;
      durationMs: number;
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

export function createConnectionsCanvasEdgeRenderer(): ConnectionsCanvasEdgeRenderer {
  let geometry: PreparedCanvasGeometry | null = null;

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
      const started = performance.now();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      const scale = camera.scale * input.devicePixelRatio;
      context.setTransform(
        scale,
        0,
        0,
        scale,
        camera.x * input.devicePixelRatio,
        camera.y * input.devicePixelRatio,
      );
      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const edgeIndex of input.visibleEdgeIndices) {
        const edge = geometry.edges[edgeIndex];
        if (!edge) continue;
        for (const section of edge.sections) {
          context.globalAlpha = 1;
          context.strokeStyle = input.colors.halo;
          context.lineWidth = CONNECTIONS_EDGE_HALO_WIDTH;
          context.stroke(section.path);

          context.globalAlpha = CONNECTIONS_EDGE_STROKE_OPACITY;
          context.strokeStyle = input.colors.stroke;
          context.lineWidth = CONNECTIONS_EDGE_STROKE_WIDTH;
          context.stroke(section.path);

          if (section.arrow) {
            context.globalAlpha = 1;
            context.fillStyle = input.colors.stroke;
            context.fill(section.arrow);
          }
        }
      }
      context.globalAlpha = 1;
      return {
        status: 'painted',
        edgeCount: input.visibleEdgeIndices.length,
        prepareDurationMs,
        durationMs: performance.now() - started,
      };
    },
    reset() {
      geometry = null;
    },
  };
}
