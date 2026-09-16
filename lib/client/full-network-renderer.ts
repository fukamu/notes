'use client';

import { fullNetworkRouteAt } from '@/lib/graph/full-network-routing';
import {
  fitFullNetworkRenderCamera,
  type FullNetworkRenderCamera,
  type FullNetworkRenderDataset,
  type FullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';

export type FullNetworkRenderColor = Readonly<{
  css: string;
  rgba: readonly [number, number, number, number];
}>;

export type FullNetworkRenderPalette = Readonly<{
  background: FullNetworkRenderColor;
  edge: FullNetworkRenderColor;
  node: FullNetworkRenderColor;
  detailEdge: FullNetworkRenderColor;
  detailNode: FullNetworkRenderColor;
  current: FullNetworkRenderColor;
  selected: FullNetworkRenderColor;
  text: FullNetworkRenderColor;
}>;

export const lightFullNetworkRenderPalette = {
  background: { css: '#fbf7ef', rgba: [0.984, 0.969, 0.937, 1] },
  edge: { css: 'rgba(26, 78, 112, 0.24)', rgba: [0.102, 0.306, 0.439, 0.24] },
  node: { css: '#315f77', rgba: [0.192, 0.373, 0.467, 0.86] },
  detailEdge: {
    css: 'rgba(18, 79, 119, 0.58)',
    rgba: [0.071, 0.31, 0.467, 0.58],
  },
  detailNode: { css: '#fffdf8', rgba: [1, 0.992, 0.973, 1] },
  current: { css: '#b65720', rgba: [0.714, 0.341, 0.125, 1] },
  selected: { css: '#1f628b', rgba: [0.122, 0.384, 0.545, 1] },
  text: { css: '#302b26', rgba: [0.188, 0.169, 0.149, 1] },
} as const satisfies FullNetworkRenderPalette;

export const darkFullNetworkRenderPalette = {
  background: { css: '#171614', rgba: [0.09, 0.086, 0.078, 1] },
  edge: { css: 'rgba(137, 194, 225, 0.3)', rgba: [0.537, 0.761, 0.882, 0.3] },
  node: { css: '#91bfd5', rgba: [0.569, 0.749, 0.835, 0.9] },
  detailEdge: {
    css: 'rgba(151, 207, 235, 0.68)',
    rgba: [0.592, 0.812, 0.922, 0.68],
  },
  detailNode: { css: '#24211d', rgba: [0.141, 0.129, 0.114, 1] },
  current: { css: '#f0a66f', rgba: [0.941, 0.651, 0.435, 1] },
  selected: { css: '#9bd6f3', rgba: [0.608, 0.839, 0.953, 1] },
  text: { css: '#f5eee4', rgba: [0.961, 0.933, 0.894, 1] },
} as const satisfies FullNetworkRenderPalette;

export const highContrastFullNetworkRenderPalette = {
  background: { css: '#000000', rgba: [0, 0, 0, 1] },
  edge: { css: '#ffffff', rgba: [1, 1, 1, 0.72] },
  node: { css: '#ffffff', rgba: [1, 1, 1, 1] },
  detailEdge: { css: '#ffffff', rgba: [1, 1, 1, 1] },
  detailNode: { css: '#000000', rgba: [0, 0, 0, 1] },
  current: { css: '#ffff00', rgba: [1, 1, 0, 1] },
  selected: { css: '#00ffff', rgba: [0, 1, 1, 1] },
  text: { css: '#ffffff', rgba: [1, 1, 1, 1] },
} as const satisfies FullNetworkRenderPalette;

export type FullNetworkVisibleNodeDetail = Readonly<{
  nodeIndex: number;
  displayLabel: string;
  title: string;
}>;

export type FullNetworkRendererSize = Readonly<{
  width: number;
  height: number;
  devicePixelRatio: number;
}>;

export type FullNetworkRendererStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'building';
      backend: 'webgl2' | 'canvas2d';
      completedItems: number;
      totalItems: number;
    }>
  | Readonly<{
      kind: 'ready';
      backend: 'webgl2' | 'canvas2d';
      nodeCount: number;
      edgeCount: number;
    }>
  | Readonly<{ kind: 'context-lost'; backend: 'webgl2' }>
  | Readonly<{ kind: 'error'; message: string }>
  | Readonly<{ kind: 'disposed' }>;

export type FullNetworkRendererSnapshot = Readonly<{
  status: FullNetworkRendererStatus;
  backend: 'webgl2' | 'canvas2d' | null;
  datasetKey: string | null;
  overviewBuildCount: number;
  overviewDrawCount: number;
  detailDrawCount: number;
  scheduledFrameCount: number;
  lastVisibleNodeCount: number;
  lastVisibleEdgeCount: number;
}>;

export type FullNetworkFrameScheduler = Readonly<{
  schedule: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}>;

export type FullNetworkBrowserRenderer = Readonly<{
  replaceDataset: (dataset: FullNetworkRenderDataset) => void;
  resize: (size: FullNetworkRendererSize) => void;
  setPalette: (palette: FullNetworkRenderPalette) => void;
  render: (
    plan: FullNetworkRenderPlan,
    visibleNodeDetails?: readonly FullNetworkVisibleNodeDetail[],
  ) => void;
  snapshot: () => FullNetworkRendererSnapshot;
  dispose: () => void;
}>;

type WebGlBackend = Readonly<{
  kind: 'webgl2';
  context: WebGL2RenderingContext;
  program: WebGLProgram;
  positionLocation: number;
  resolutionLocation: WebGLUniformLocation;
  offsetLocation: WebGLUniformLocation;
  scaleLocation: WebGLUniformLocation;
  pointSizeLocation: WebGLUniformLocation;
  colorLocation: WebGLUniformLocation;
  edgeBuffer: WebGLBuffer;
  nodeBuffer: WebGLBuffer;
}>;

type CanvasBackend = {
  kind: 'canvas2d';
  context: CanvasRenderingContext2D;
  edgeIndex: number;
  nodeIndex: number;
};

type OverviewBackend = WebGlBackend | CanvasBackend;

type PendingView = Readonly<{
  plan: FullNetworkRenderPlan;
  details: readonly FullNetworkVisibleNodeDetail[];
}>;

const canvasChunkItems = 20_000;

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function typedValue(
  values: Uint32Array | Float32Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function shader(
  context: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const result = context.createShader(type);
  if (!result) throw new Error('WebGL could not allocate a shader');
  context.shaderSource(result, source);
  context.compileShader(result);
  if (!context.getShaderParameter(result, context.COMPILE_STATUS)) {
    const reason = context.getShaderInfoLog(result) ?? 'unknown compile error';
    context.deleteShader(result);
    throw new Error(`WebGL shader compilation failed: ${reason}`);
  }
  return result;
}

function webGlLocation(
  context: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = context.getUniformLocation(program, name);
  if (!location) throw new Error(`WebGL omitted uniform ${name}`);
  return location;
}

function createWebGlBackend(context: WebGL2RenderingContext): WebGlBackend {
  const vertex = shader(
    context,
    context.VERTEX_SHADER,
    `#version 300 es
    in vec2 a_position;
    uniform vec2 u_resolution;
    uniform vec2 u_offset;
    uniform float u_scale;
    uniform float u_point_size;
    void main() {
      vec2 pixel = a_position * u_scale + u_offset;
      vec2 clip = pixel / u_resolution * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      gl_PointSize = u_point_size;
    }`,
  );
  const fragment = shader(
    context,
    context.FRAGMENT_SHADER,
    `#version 300 es
    precision mediump float;
    uniform vec4 u_color;
    out vec4 output_color;
    void main() { output_color = u_color; }`,
  );
  const program = context.createProgram();
  if (!program) {
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    throw new Error('WebGL could not allocate a program');
  }
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  context.deleteShader(vertex);
  context.deleteShader(fragment);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    const reason = context.getProgramInfoLog(program) ?? 'unknown link error';
    context.deleteProgram(program);
    throw new Error(`WebGL program linking failed: ${reason}`);
  }
  const positionLocation = context.getAttribLocation(program, 'a_position');
  if (positionLocation < 0) {
    context.deleteProgram(program);
    throw new Error('WebGL omitted position attribute');
  }
  const edgeBuffer = context.createBuffer();
  const nodeBuffer = context.createBuffer();
  if (!edgeBuffer || !nodeBuffer) {
    if (edgeBuffer) context.deleteBuffer(edgeBuffer);
    if (nodeBuffer) context.deleteBuffer(nodeBuffer);
    context.deleteProgram(program);
    throw new Error('WebGL could not allocate renderer buffers');
  }
  return {
    kind: 'webgl2',
    context,
    program,
    positionLocation,
    resolutionLocation: webGlLocation(context, program, 'u_resolution'),
    offsetLocation: webGlLocation(context, program, 'u_offset'),
    scaleLocation: webGlLocation(context, program, 'u_scale'),
    pointSizeLocation: webGlLocation(context, program, 'u_point_size'),
    colorLocation: webGlLocation(context, program, 'u_color'),
    edgeBuffer,
    nodeBuffer,
  };
}

function deleteBackend(backend: OverviewBackend | null): void {
  if (!backend || backend.kind !== 'webgl2') return;
  backend.context.deleteBuffer(backend.edgeBuffer);
  backend.context.deleteBuffer(backend.nodeBuffer);
  backend.context.deleteProgram(backend.program);
}

function rgba(
  context: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  color: FullNetworkRenderColor,
): void {
  context.uniform4f(
    location,
    color.rgba[0],
    color.rgba[1],
    color.rgba[2],
    color.rgba[3],
  );
}

function setCanvasSize(
  canvas: HTMLCanvasElement,
  size: FullNetworkRendererSize,
): void {
  const width = Math.max(1, Math.round(size.width * size.devicePixelRatio));
  const height = Math.max(1, Math.round(size.height * size.devicePixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
}

function clearCanvas2d(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  palette: FullNetworkRenderPalette,
  devicePixelRatio: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = palette.background.css;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function createBackend(
  canvas: HTMLCanvasElement,
  preferredBackend: 'webgl2' | 'canvas2d',
): OverviewBackend {
  if (preferredBackend === 'webgl2') {
    const webgl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (webgl) return createWebGlBackend(webgl);
  }
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Neither WebGL2 nor Canvas2D is available');
  return { kind: 'canvas2d', context, edgeIndex: 0, nodeIndex: 0 };
}

function configureWebGlGeometry(
  backend: WebGlBackend,
  dataset: FullNetworkRenderDataset,
): void {
  const { context } = backend;
  context.bindBuffer(context.ARRAY_BUFFER, backend.edgeBuffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    dataset.overview.edgePositions,
    context.STATIC_DRAW,
  );
  context.bindBuffer(context.ARRAY_BUFFER, backend.nodeBuffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    dataset.overview.nodePositions,
    context.STATIC_DRAW,
  );
}

function prepareWebGl(
  backend: WebGlBackend,
  size: FullNetworkRendererSize,
  camera: FullNetworkRenderCamera,
): void {
  const { context } = backend;
  context.viewport(
    0,
    0,
    context.drawingBufferWidth,
    context.drawingBufferHeight,
  );
  const maximumTextureSize: unknown = context.getParameter(
    context.MAX_TEXTURE_SIZE,
  );
  if (
    typeof maximumTextureSize !== 'number' ||
    !Number.isFinite(maximumTextureSize) ||
    context.drawingBufferWidth > maximumTextureSize ||
    context.drawingBufferHeight > maximumTextureSize
  ) {
    throw new Error('WebGL viewport exceeds the supported texture size');
  }
  context.useProgram(backend.program);
  context.enable(context.BLEND);
  context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA);
  context.uniform2f(
    backend.resolutionLocation,
    size.width * size.devicePixelRatio,
    size.height * size.devicePixelRatio,
  );
  context.uniform2f(
    backend.offsetLocation,
    camera.offsetX * size.devicePixelRatio,
    camera.offsetY * size.devicePixelRatio,
  );
  context.uniform1f(
    backend.scaleLocation,
    camera.scale * size.devicePixelRatio,
  );
  context.enableVertexAttribArray(backend.positionLocation);
}

function drawWebGlOverview(
  backend: WebGlBackend,
  dataset: FullNetworkRenderDataset,
  size: FullNetworkRendererSize,
  camera: FullNetworkRenderCamera,
  palette: FullNetworkRenderPalette,
): void {
  const { context } = backend;
  prepareWebGl(backend, size, camera);
  context.clearColor(...palette.background.rgba);
  context.clear(context.COLOR_BUFFER_BIT);
  context.bindBuffer(context.ARRAY_BUFFER, backend.edgeBuffer);
  context.vertexAttribPointer(
    backend.positionLocation,
    2,
    context.FLOAT,
    false,
    0,
    0,
  );
  rgba(context, backend.colorLocation, palette.edge);
  context.uniform1f(backend.pointSizeLocation, size.devicePixelRatio);
  context.drawArrays(context.LINES, 0, dataset.overview.edgeCount * 2);
  context.drawArrays(context.POINTS, 0, dataset.overview.edgeCount * 2);
  context.bindBuffer(context.ARRAY_BUFFER, backend.nodeBuffer);
  context.vertexAttribPointer(
    backend.positionLocation,
    2,
    context.FLOAT,
    false,
    0,
    0,
  );
  rgba(context, backend.colorLocation, palette.node);
  context.uniform1f(backend.pointSizeLocation, 2 * size.devicePixelRatio);
  context.drawArrays(context.POINTS, 0, dataset.overview.nodeCount);
}

function canvasPoint(
  camera: FullNetworkRenderCamera,
  x: number,
  y: number,
): Readonly<{ x: number; y: number }> {
  return {
    x: camera.offsetX + x * camera.scale,
    y: camera.offsetY + y * camera.scale,
  };
}

function drawCanvasOverviewChunk(
  input: Readonly<{
    backend: CanvasBackend;
    canvas: HTMLCanvasElement;
    dataset: FullNetworkRenderDataset;
    size: FullNetworkRendererSize;
    camera: FullNetworkRenderCamera;
    palette: FullNetworkRenderPalette;
  }>,
): boolean {
  const { backend, canvas, dataset, size, camera, palette } = input;
  if (backend.edgeIndex === 0 && backend.nodeIndex === 0) {
    clearCanvas2d(backend.context, canvas, palette, size.devicePixelRatio);
  }
  let remaining = canvasChunkItems;
  const context = backend.context;
  context.strokeStyle = palette.edge.css;
  context.fillStyle = palette.edge.css;
  context.lineWidth = 1;
  context.beginPath();
  while (backend.edgeIndex < dataset.overview.edgeCount && remaining > 0) {
    const offset = backend.edgeIndex * 4;
    const source = canvasPoint(
      camera,
      typedValue(dataset.overview.edgePositions, offset, 'edge source x'),
      typedValue(dataset.overview.edgePositions, offset + 1, 'edge source y'),
    );
    const target = canvasPoint(
      camera,
      typedValue(dataset.overview.edgePositions, offset + 2, 'edge target x'),
      typedValue(dataset.overview.edgePositions, offset + 3, 'edge target y'),
    );
    if (source.x === target.x && source.y === target.y) {
      context.moveTo(source.x + 1, source.y);
      context.arc(source.x, source.y, 1, 0, Math.PI * 2);
    } else {
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
    }
    backend.edgeIndex += 1;
    remaining -= 1;
  }
  context.stroke();
  if (backend.edgeIndex < dataset.overview.edgeCount) return false;
  context.fillStyle = palette.node.css;
  context.beginPath();
  while (backend.nodeIndex < dataset.overview.nodeCount && remaining > 0) {
    const offset = backend.nodeIndex * 2;
    const point = canvasPoint(
      camera,
      typedValue(dataset.overview.nodePositions, offset, 'node x'),
      typedValue(dataset.overview.nodePositions, offset + 1, 'node y'),
    );
    context.moveTo(point.x + 1.25, point.y);
    context.arc(point.x, point.y, 1.25, 0, Math.PI * 2);
    backend.nodeIndex += 1;
    remaining -= 1;
  }
  context.fill();
  return backend.nodeIndex >= dataset.overview.nodeCount;
}

function drawArrow(
  context: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = 5;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(toX, toY);
  context.lineTo(
    toX - Math.cos(angle - Math.PI / 6) * size,
    toY - Math.sin(angle - Math.PI / 6) * size,
  );
  context.lineTo(
    toX - Math.cos(angle + Math.PI / 6) * size,
    toY - Math.sin(angle + Math.PI / 6) * size,
  );
  context.closePath();
  context.fill();
}

function drawDetailLayer(
  input: Readonly<{
    context: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    dataset: FullNetworkRenderDataset;
    view: PendingView;
    size: FullNetworkRendererSize;
    palette: FullNetworkRenderPalette;
  }>,
): void {
  const { context, canvas, dataset, view, size, palette } = input;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(
    size.devicePixelRatio,
    0,
    0,
    size.devicePixelRatio,
    0,
    0,
  );
  const camera = view.plan.camera;
  const currentEdges = new Set(view.plan.currentIncidentEdgeIndexes);
  const selectedEdges = new Set(view.plan.selectedIncidentEdgeIndexes);
  const edgeIndexes =
    view.plan.level === 'overview'
      ? view.plan.emphasizedEdgeIndexes
      : view.plan.visibleEdgeIndexes;
  for (const edgeIndex of edgeIndexes) {
    const route = fullNetworkRouteAt(dataset.routing, edgeIndex);
    const selected = selectedEdges.has(edgeIndex);
    const current = currentEdges.has(edgeIndex);
    const emphasized = selected || current;
    const color = selected
      ? palette.selected.css
      : current
        ? palette.current.css
        : palette.detailEdge.css;
    context.strokeStyle = color;
    context.lineWidth = emphasized ? 2.5 : 1.25;
    context.beginPath();
    let previousX = 0;
    let previousY = 0;
    let arrow:
      | Readonly<{ fromX: number; fromY: number; toX: number; toY: number }>
      | undefined;
    for (let offset = 0; offset < route.coordinates.length; offset += 2) {
      const point = canvasPoint(
        camera,
        typedValue(route.coordinates, offset, 'route x'),
        typedValue(route.coordinates, offset + 1, 'route y'),
      );
      if (offset === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
      if (offset + 2 === route.coordinates.length) {
        if (view.plan.directionsVisible) {
          arrow = {
            fromX: previousX,
            fromY: previousY,
            toX: point.x,
            toY: point.y,
          };
        }
      }
      previousX = point.x;
      previousY = point.y;
    }
    context.stroke();
    if (arrow) {
      drawArrow(context, arrow.fromX, arrow.fromY, arrow.toX, arrow.toY, color);
    }
  }
  const nodeIndexes =
    view.plan.level === 'overview'
      ? view.plan.emphasizedNodeIndexes
      : view.plan.visibleNodeIndexes;
  const halfWidth =
    dataset.routing.routingConfiguration.nodeHalfWidth * camera.scale;
  const halfHeight =
    dataset.routing.routingConfiguration.nodeHalfHeight * camera.scale;
  for (const nodeIndex of nodeIndexes) {
    const point = canvasPoint(
      camera,
      typedValue(dataset.routing.layout.x, nodeIndex, 'visible node x'),
      typedValue(dataset.routing.layout.y, nodeIndex, 'visible node y'),
    );
    context.fillStyle = palette.detailNode.css;
    const selected = nodeIndex === view.plan.selectedNodeIndex;
    const current = nodeIndex === view.plan.currentNodeIndex;
    context.strokeStyle = selected
      ? palette.selected.css
      : current
        ? palette.current.css
        : palette.node.css;
    context.lineWidth = selected || current ? 2.5 : 1;
    context.beginPath();
    context.roundRect(
      point.x - halfWidth,
      point.y - halfHeight,
      halfWidth * 2,
      halfHeight * 2,
      Math.min(4, halfHeight),
    );
    context.fill();
    context.stroke();
  }
  if (!view.plan.labelsVisible) return;
  context.fillStyle = palette.text.css;
  context.font = '12px system-ui, sans-serif';
  context.textBaseline = 'middle';
  const maximumLabelWidth = Math.max(
    0,
    (dataset.routing.layoutConfiguration.cellWidth -
      dataset.routing.routingConfiguration.nodeHalfWidth * 2) *
      camera.scale -
      8,
  );
  if (maximumLabelWidth < 12) return;
  for (const detail of view.details) {
    const point = canvasPoint(
      camera,
      typedValue(dataset.routing.layout.x, detail.nodeIndex, 'label node x'),
      typedValue(dataset.routing.layout.y, detail.nodeIndex, 'label node y'),
    );
    const text = detail.title || detail.displayLabel;
    context.fillText(text, point.x + halfWidth + 4, point.y, maximumLabelWidth);
  }
}

function validateDetails(
  plan: FullNetworkRenderPlan,
  details: readonly FullNetworkVisibleNodeDetail[],
): readonly FullNetworkVisibleNodeDetail[] {
  const visible = new Set(plan.visibleNodeIndexes);
  const seen = new Set<number>();
  return details.map((detail) => {
    if (
      !Number.isSafeInteger(detail.nodeIndex) ||
      detail.nodeIndex < 0 ||
      !visible.has(detail.nodeIndex) ||
      seen.has(detail.nodeIndex)
    ) {
      throw new RangeError(
        `Detail node ${detail.nodeIndex} is not a unique visible node`,
      );
    }
    seen.add(detail.nodeIndex);
    return {
      nodeIndex: detail.nodeIndex,
      displayLabel: detail.displayLabel,
      title: detail.title,
    };
  });
}

function sameSize(
  left: FullNetworkRendererSize,
  right: FullNetworkRendererSize,
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.devicePixelRatio === right.devicePixelRatio
  );
}

export function createFullNetworkBrowserRenderer(
  input: Readonly<{
    overviewCanvas: HTMLCanvasElement;
    detailCanvas: HTMLCanvasElement;
    preferredBackend?: 'webgl2' | 'canvas2d';
    scheduler?: FullNetworkFrameScheduler;
    onStatus?: (status: FullNetworkRendererStatus) => void;
  }>,
): FullNetworkBrowserRenderer {
  const preferredBackend = input.preferredBackend ?? 'webgl2';
  const scheduler = input.scheduler ?? {
    schedule: (callback: FrameRequestCallback) =>
      window.requestAnimationFrame(callback),
    cancel: (handle: number) => window.cancelAnimationFrame(handle),
  };
  const detailContext = input.detailCanvas.getContext('2d', { alpha: true });
  if (!detailContext) throw new Error('Detail Canvas2D is unavailable');
  let status: FullNetworkRendererStatus = { kind: 'idle' };
  let backend: OverviewBackend | null = null;
  let dataset: FullNetworkRenderDataset | null = null;
  let size: FullNetworkRendererSize = {
    width: 1,
    height: 1,
    devicePixelRatio: 1,
  };
  let palette: FullNetworkRenderPalette = lightFullNetworkRenderPalette;
  let baseCamera: FullNetworkRenderCamera | null = null;
  let pendingRebuild = false;
  let pendingView: PendingView | null = null;
  let activeView: PendingView | null = null;
  let uploadedGeometryKey: string | null = null;
  let frameHandle: number | null = null;
  let disposed = false;
  let overviewBuildCount = 0;
  let overviewDrawCount = 0;
  let detailDrawCount = 0;
  let scheduledFrameCount = 0;
  let lastVisibleNodeCount = 0;
  let lastVisibleEdgeCount = 0;

  const publish = (next: FullNetworkRendererStatus): void => {
    status = next;
    input.onStatus?.(next);
  };

  const initializeBackend = (): OverviewBackend => {
    deleteBackend(backend);
    backend = createBackend(input.overviewCanvas, preferredBackend);
    uploadedGeometryKey = null;
    return backend;
  };

  const applyOverviewTransform = (camera: FullNetworkRenderCamera): void => {
    if (!baseCamera) return;
    const ratio = camera.scale / baseCamera.scale;
    const translateX = camera.offsetX - ratio * baseCamera.offsetX;
    const translateY = camera.offsetY - ratio * baseCamera.offsetY;
    input.overviewCanvas.style.transformOrigin = '0 0';
    input.overviewCanvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${ratio})`;
  };

  const rebuildOverview = (): boolean => {
    if (!dataset) return true;
    setCanvasSize(input.overviewCanvas, size);
    setCanvasSize(input.detailCanvas, size);
    baseCamera = fitFullNetworkRenderCamera({
      dataset,
      viewportWidth: size.width,
      viewportHeight: size.height,
      paddingPixels: 12,
    });
    const active = backend ?? initializeBackend();
    const totalItems = dataset.overview.edgeCount + dataset.overview.nodeCount;
    if (active.kind === 'webgl2') {
      if (uploadedGeometryKey !== dataset.overview.geometryKey) {
        configureWebGlGeometry(active, dataset);
        uploadedGeometryKey = dataset.overview.geometryKey;
        overviewBuildCount += 1;
      }
      drawWebGlOverview(active, dataset, size, baseCamera, palette);
      overviewDrawCount += 1;
      publish({
        kind: 'ready',
        backend: 'webgl2',
        nodeCount: dataset.overview.nodeCount,
        edgeCount: dataset.overview.edgeCount,
      });
      return true;
    }
    const complete = drawCanvasOverviewChunk({
      backend: active,
      canvas: input.overviewCanvas,
      dataset,
      size,
      camera: baseCamera,
      palette,
    });
    overviewDrawCount += 1;
    const completedItems = active.edgeIndex + active.nodeIndex;
    if (complete) {
      overviewBuildCount += 1;
      publish({
        kind: 'ready',
        backend: 'canvas2d',
        nodeCount: dataset.overview.nodeCount,
        edgeCount: dataset.overview.edgeCount,
      });
    } else {
      publish({
        kind: 'building',
        backend: 'canvas2d',
        completedItems,
        totalItems,
      });
    }
    return complete;
  };

  const drawView = (): void => {
    const view = pendingView;
    if (!view || !dataset) return;
    pendingView = null;
    activeView = view;
    applyOverviewTransform(view.plan.camera);
    input.detailCanvas.style.opacity =
      view.plan.level === 'network' ? '0.72' : '1';
    input.detailCanvas.style.transition =
      view.plan.transition.kind === 'crossfade'
        ? 'opacity 120ms ease-out'
        : 'none';
    drawDetailLayer({
      context: detailContext,
      canvas: input.detailCanvas,
      dataset,
      view,
      size,
      palette,
    });
    detailDrawCount += 1;
    lastVisibleNodeCount = view.plan.visibleNodeIndexes.length;
    lastVisibleEdgeCount = view.plan.visibleEdgeIndexes.length;
  };

  const runFrame = (): void => {
    frameHandle = null;
    if (disposed) return;
    scheduledFrameCount += 1;
    try {
      if (pendingRebuild) {
        const complete = rebuildOverview();
        pendingRebuild = !complete;
      }
      drawView();
      if (pendingRebuild || pendingView) queueFrame();
    } catch (error: unknown) {
      pendingRebuild = false;
      publish({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Renderer failed',
      });
    }
  };

  function queueFrame(): void {
    if (disposed || frameHandle !== null) return;
    frameHandle = scheduler.schedule(runFrame);
  }

  const loseContext = (event: Event): void => {
    event.preventDefault();
    if (disposed || backend?.kind !== 'webgl2') return;
    pendingRebuild = false;
    publish({ kind: 'context-lost', backend: 'webgl2' });
  };

  const restoreContext = (): void => {
    if (disposed || !dataset) return;
    deleteBackend(backend);
    backend = null;
    uploadedGeometryKey = null;
    pendingRebuild = true;
    publish({
      kind: 'building',
      backend: 'webgl2',
      completedItems: 0,
      totalItems: dataset.overview.edgeCount + dataset.overview.nodeCount,
    });
    queueFrame();
  };

  input.overviewCanvas.addEventListener('webglcontextlost', loseContext);
  input.overviewCanvas.addEventListener('webglcontextrestored', restoreContext);

  return {
    replaceDataset(nextDataset) {
      if (disposed) throw new Error('Full-network renderer is disposed');
      if (dataset?.datasetKey === nextDataset.datasetKey) return;
      deleteBackend(backend);
      dataset = nextDataset;
      backend = null;
      baseCamera = null;
      uploadedGeometryKey = null;
      pendingRebuild = true;
      pendingView = null;
      activeView = null;
      publish({
        kind: 'building',
        backend: preferredBackend,
        completedItems: 0,
        totalItems:
          nextDataset.overview.edgeCount + nextDataset.overview.nodeCount,
      });
      queueFrame();
    },
    resize(nextSize) {
      if (disposed) throw new Error('Full-network renderer is disposed');
      positiveFinite(nextSize.width, 'renderer width');
      positiveFinite(nextSize.height, 'renderer height');
      positiveFinite(nextSize.devicePixelRatio, 'devicePixelRatio');
      const validated = {
        width: nextSize.width,
        height: nextSize.height,
        devicePixelRatio: nextSize.devicePixelRatio,
      };
      if (sameSize(size, validated)) return;
      size = validated;
      if (backend?.kind === 'canvas2d') {
        backend.edgeIndex = 0;
        backend.nodeIndex = 0;
      }
      pendingRebuild = dataset !== null;
      pendingView = activeView;
      queueFrame();
    },
    setPalette(nextPalette) {
      if (disposed) throw new Error('Full-network renderer is disposed');
      if (palette === nextPalette) return;
      palette = nextPalette;
      if (backend?.kind === 'canvas2d') {
        backend.edgeIndex = 0;
        backend.nodeIndex = 0;
      }
      pendingRebuild = dataset !== null;
      pendingView = activeView;
      queueFrame();
    },
    render(plan, visibleNodeDetails = []) {
      if (disposed) throw new Error('Full-network renderer is disposed');
      if (!dataset || plan.datasetKey !== dataset.datasetKey) {
        throw new Error('Render plan does not match the active dataset');
      }
      pendingView = {
        plan,
        details: validateDetails(plan, visibleNodeDetails),
      };
      queueFrame();
    },
    snapshot() {
      return {
        status,
        backend: backend?.kind ?? null,
        datasetKey: dataset?.datasetKey ?? null,
        overviewBuildCount,
        overviewDrawCount,
        detailDrawCount,
        scheduledFrameCount,
        lastVisibleNodeCount,
        lastVisibleEdgeCount,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== null) scheduler.cancel(frameHandle);
      frameHandle = null;
      pendingView = null;
      activeView = null;
      pendingRebuild = false;
      dataset = null;
      baseCamera = null;
      uploadedGeometryKey = null;
      input.overviewCanvas.removeEventListener('webglcontextlost', loseContext);
      input.overviewCanvas.removeEventListener(
        'webglcontextrestored',
        restoreContext,
      );
      deleteBackend(backend);
      backend = null;
      detailContext.setTransform(1, 0, 0, 1, 0, 0);
      detailContext.clearRect(
        0,
        0,
        input.detailCanvas.width,
        input.detailCanvas.height,
      );
      input.overviewCanvas.width = 1;
      input.overviewCanvas.height = 1;
      input.detailCanvas.width = 1;
      input.detailCanvas.height = 1;
      publish({ kind: 'disposed' });
    },
  };
}
