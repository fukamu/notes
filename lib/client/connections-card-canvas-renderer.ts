import type { ConnectionsReadyNode } from '@/lib/graph/connections-contract';
import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';

export type ConnectionsCanvasCardColors = Readonly<{
  fill: string;
  border: string;
  current: string;
}>;

export type ConnectionsCanvasCardPaintResult =
  | Readonly<{
      status: 'painted';
      nodeCount: number;
      durationMs: number;
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
  }) => ConnectionsCanvasCardPaintResult;
  clear: (input: {
    canvas: HTMLCanvasElement;
    viewport: Readonly<{ width: number; height: number }>;
    devicePixelRatio: number;
  }) => ConnectionsCanvasCardPaintResult;
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

export function createConnectionsCanvasCardRenderer(): ConnectionsCanvasCardRenderer {
  let cleared = false;
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
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      const scale = input.camera.scale * input.devicePixelRatio;
      context.setTransform(
        scale,
        0,
        0,
        scale,
        input.camera.x * input.devicePixelRatio,
        input.camera.y * input.devicePixelRatio,
      );

      const currentNodes: ConnectionsReadyNode[] = [];
      let nodeCount = 0;
      context.beginPath();
      for (const nodeIndex of input.visibleNodeIndices) {
        if (nodeIndex === input.excludedNodeIndex) continue;
        const node = input.nodes[nodeIndex];
        if (!node) continue;
        nodeCount += 1;
        if (node.current) {
          currentNodes.push(node);
          continue;
        }
        appendCardPath(context, node);
      }
      context.globalAlpha = 1;
      context.fillStyle = input.colors.fill;
      context.fill();
      context.strokeStyle = input.colors.border;
      context.lineWidth = 1;
      context.stroke();

      for (const node of currentNodes) {
        context.beginPath();
        appendCardPath(context, node);
        context.globalAlpha = 1;
        context.fillStyle = input.colors.fill;
        context.fill();
        context.globalAlpha = 0.18;
        context.fillStyle = input.colors.current;
        context.fill();
        context.globalAlpha = 1;
        context.strokeStyle = input.colors.current;
        context.lineWidth = 3 / input.camera.scale;
        context.stroke();
      }
      context.globalAlpha = 1;
      cleared = false;
      return {
        status: 'painted',
        nodeCount,
        durationMs: performance.now() - started,
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
  };
}
