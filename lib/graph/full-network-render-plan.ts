import type { CardId } from '@/lib/domain/id';
import {
  queryFullNetworkRoutes,
  validateFullNetworkRouting,
  type FullNetworkRouting,
  type FullNetworkViewport,
} from '@/lib/graph/full-network-routing';

export type FullNetworkSemanticLevel = 'overview' | 'network' | 'detail';

export type FullNetworkRenderCamera = Readonly<{
  offsetX: number;
  offsetY: number;
  scale: number;
  viewportWidth: number;
  viewportHeight: number;
}>;

export type FullNetworkRenderConfiguration = Readonly<{
  version: 1;
  overviewToNetworkPixels: number;
  networkToOverviewPixels: number;
  networkToDetailPixels: number;
  detailToNetworkPixels: number;
  detailOverscanPixels: number;
}>;

export const defaultFullNetworkRenderConfiguration = {
  version: 1,
  overviewToNetworkPixels: 3,
  networkToOverviewPixels: 2,
  networkToDetailPixels: 32,
  detailToNetworkPixels: 28,
  detailOverscanPixels: 64,
} as const satisfies FullNetworkRenderConfiguration;

export type FullNetworkOverviewGeometry = Readonly<{
  geometryKey: string;
  nodeCount: number;
  edgeCount: number;
  nodePositions: Float32Array;
  edgePositions: Float32Array;
}>;

export type FullNetworkNodeSpatialIndex = Readonly<{
  nodeIndexesByX: Uint32Array;
}>;

export type FullNetworkIncidentIndex = Readonly<{
  offsets: Uint32Array;
  edgeIndexes: Uint32Array;
}>;

export type FullNetworkRenderDataset = Readonly<{
  datasetKey: string;
  routing: FullNetworkRouting;
  overview: FullNetworkOverviewGeometry;
  nodes: FullNetworkNodeSpatialIndex;
  incidents: FullNetworkIncidentIndex;
  nodeIndexesByCardId: ReadonlyMap<CardId, number>;
}>;

export type FullNetworkLevelTransition =
  | Readonly<{ kind: 'stable'; level: FullNetworkSemanticLevel }>
  | Readonly<{
      kind: 'cut';
      from: FullNetworkSemanticLevel;
      to: FullNetworkSemanticLevel;
    }>
  | Readonly<{
      kind: 'crossfade';
      from: FullNetworkSemanticLevel;
      to: FullNetworkSemanticLevel;
    }>;

export type FullNetworkRenderPlan = Readonly<{
  planKey: string;
  datasetKey: string;
  level: FullNetworkSemanticLevel;
  transition: FullNetworkLevelTransition;
  camera: FullNetworkRenderCamera;
  worldViewport: FullNetworkViewport;
  projectedNodePixels: number;
  overviewNodeCount: number;
  overviewEdgeCount: number;
  visibleNodeIndexes: Uint32Array;
  visibleEdgeIndexes: Uint32Array;
  currentNodeIndex: number | null;
  selectedNodeIndex: number | null;
  currentIncidentEdgeIndexes: Uint32Array;
  selectedIncidentEdgeIndexes: Uint32Array;
  emphasizedNodeIndexes: Uint32Array;
  emphasizedEdgeIndexes: Uint32Array;
  labelsVisible: boolean;
  directionsVisible: boolean;
}>;

export type FullNetworkRendererGeometryBytes = Readonly<{
  overviewEdgePositions: number;
  overviewNodePositions: number;
  nodeSpatialIndex: number;
  incidentOffsets: number;
  incidentEdgeIndexes: number;
  total: number;
}>;

function typedValue(
  values: Uint32Array | Float32Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function validateRenderConfiguration(
  configuration: FullNetworkRenderConfiguration,
): void {
  if (configuration.version !== 1) {
    throw new RangeError('Unsupported full-network render configuration');
  }
  const networkEnter = positiveFinite(
    configuration.overviewToNetworkPixels,
    'overviewToNetworkPixels',
  );
  const networkExit = positiveFinite(
    configuration.networkToOverviewPixels,
    'networkToOverviewPixels',
  );
  const detailEnter = positiveFinite(
    configuration.networkToDetailPixels,
    'networkToDetailPixels',
  );
  const detailExit = positiveFinite(
    configuration.detailToNetworkPixels,
    'detailToNetworkPixels',
  );
  nonNegativeFinite(configuration.detailOverscanPixels, 'detailOverscanPixels');
  if (
    networkExit >= networkEnter ||
    networkEnter >= detailExit ||
    detailExit >= detailEnter
  ) {
    throw new RangeError(
      'Full-network render thresholds must define non-overlapping hysteresis bands',
    );
  }
}

function validateCamera(camera: FullNetworkRenderCamera): void {
  finite(camera.offsetX, 'camera.offsetX');
  finite(camera.offsetY, 'camera.offsetY');
  positiveFinite(camera.scale, 'camera.scale');
  positiveFinite(camera.viewportWidth, 'camera.viewportWidth');
  positiveFinite(camera.viewportHeight, 'camera.viewportHeight');
}

function createOverviewGeometry(
  routing: FullNetworkRouting,
): FullNetworkOverviewGeometry {
  const { topology, layout } = routing;
  const nodeCount = topology.nodeIds.length;
  const edgeCount = topology.sources.length;
  const nodePositions = new Float32Array(nodeCount * 2);
  for (let node = 0; node < nodeCount; node += 1) {
    nodePositions[node * 2] = typedValue(layout.x, node, 'node x');
    nodePositions[node * 2 + 1] = typedValue(layout.y, node, 'node y');
  }
  const edgePositions = new Float32Array(edgeCount * 4);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const source = typedValue(topology.sources, edge, 'edge source');
    const target = typedValue(topology.targets, edge, 'edge target');
    edgePositions[edge * 4] = typedValue(layout.x, source, 'source x');
    edgePositions[edge * 4 + 1] = typedValue(layout.y, source, 'source y');
    edgePositions[edge * 4 + 2] = typedValue(layout.x, target, 'target x');
    edgePositions[edge * 4 + 3] = typedValue(layout.y, target, 'target y');
  }
  return {
    geometryKey: `${routing.routingKey}:overview-v1`,
    nodeCount,
    edgeCount,
    nodePositions,
    edgePositions,
  };
}

function createNodeSpatialIndex(
  routing: FullNetworkRouting,
): FullNetworkNodeSpatialIndex {
  const indexes = Array.from(
    { length: routing.layout.nodeCount },
    (_, node) => node,
  );
  indexes.sort(
    (left, right) =>
      typedValue(routing.layout.x, left, 'left node x') -
        typedValue(routing.layout.x, right, 'right node x') ||
      typedValue(routing.layout.y, left, 'left node y') -
        typedValue(routing.layout.y, right, 'right node y') ||
      left - right,
  );
  return { nodeIndexesByX: Uint32Array.from(indexes) };
}

function createIncidentIndex(
  routing: FullNetworkRouting,
): FullNetworkIncidentIndex {
  const nodeCount = routing.layout.nodeCount;
  const edgeCount = routing.topology.sources.length;
  const degrees = new Uint32Array(nodeCount);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const source = typedValue(routing.topology.sources, edge, 'edge source');
    const target = typedValue(routing.topology.targets, edge, 'edge target');
    degrees[source] = typedValue(degrees, source, 'source degree') + 1;
    if (target !== source) {
      degrees[target] = typedValue(degrees, target, 'target degree') + 1;
    }
  }
  const offsets = new Uint32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) {
    offsets[node + 1] =
      typedValue(offsets, node, 'incident offset') +
      typedValue(degrees, node, 'incident degree');
  }
  const edgeIndexes = new Uint32Array(
    typedValue(offsets, nodeCount, 'final incident offset'),
  );
  const cursors = new Uint32Array(offsets);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const source = typedValue(routing.topology.sources, edge, 'edge source');
    const target = typedValue(routing.topology.targets, edge, 'edge target');
    const sourceCursor = typedValue(cursors, source, 'source cursor');
    edgeIndexes[sourceCursor] = edge;
    cursors[source] = sourceCursor + 1;
    if (target !== source) {
      const targetCursor = typedValue(cursors, target, 'target cursor');
      edgeIndexes[targetCursor] = edge;
      cursors[target] = targetCursor + 1;
    }
  }
  return { offsets, edgeIndexes };
}

export function createFullNetworkRenderDataset(
  routing: FullNetworkRouting,
): FullNetworkRenderDataset {
  validateFullNetworkRouting(routing);
  const nodeIndexesByCardId = new Map<CardId, number>();
  for (const [index, cardId] of routing.topology.nodeIds.entries()) {
    if (nodeIndexesByCardId.has(cardId)) {
      throw new Error(
        `Full-network renderer contains duplicate node ${cardId}`,
      );
    }
    nodeIndexesByCardId.set(cardId, index);
  }
  const overview = createOverviewGeometry(routing);
  return {
    datasetKey: `${overview.geometryKey}:render-dataset-v1`,
    routing,
    overview,
    nodes: createNodeSpatialIndex(routing),
    incidents: createIncidentIndex(routing),
    nodeIndexesByCardId,
  };
}

function upperBoundNodeX(
  dataset: FullNetworkRenderDataset,
  maximumX: number,
): number {
  let low = 0;
  let high = dataset.nodes.nodeIndexesByX.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const node = typedValue(
      dataset.nodes.nodeIndexesByX,
      middle,
      'sorted node',
    );
    if (typedValue(dataset.routing.layout.x, node, 'node x') <= maximumX) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function lowerBoundNodeX(
  dataset: FullNetworkRenderDataset,
  minimumX: number,
): number {
  let low = 0;
  let high = dataset.nodes.nodeIndexesByX.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const node = typedValue(
      dataset.nodes.nodeIndexesByX,
      middle,
      'sorted node',
    );
    if (typedValue(dataset.routing.layout.x, node, 'node x') < minimumX) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function queryFullNetworkNodes(
  dataset: FullNetworkRenderDataset,
  viewport: FullNetworkViewport,
): Uint32Array {
  finite(viewport.minX, 'viewport.minX');
  finite(viewport.minY, 'viewport.minY');
  finite(viewport.maxX, 'viewport.maxX');
  finite(viewport.maxY, 'viewport.maxY');
  if (viewport.minX > viewport.maxX || viewport.minY > viewport.maxY) {
    throw new RangeError('Full-network viewport bounds are inverted');
  }
  const halfWidth = dataset.routing.routingConfiguration.nodeHalfWidth;
  const halfHeight = dataset.routing.routingConfiguration.nodeHalfHeight;
  const matches: number[] = [];
  const start = lowerBoundNodeX(dataset, viewport.minX - halfWidth);
  const limit = upperBoundNodeX(dataset, viewport.maxX + halfWidth);
  for (let position = start; position < limit; position += 1) {
    const node = typedValue(
      dataset.nodes.nodeIndexesByX,
      position,
      'sorted node',
    );
    const x = typedValue(dataset.routing.layout.x, node, 'node x');
    const y = typedValue(dataset.routing.layout.y, node, 'node y');
    if (
      x + halfWidth >= viewport.minX &&
      y + halfHeight >= viewport.minY &&
      y - halfHeight <= viewport.maxY
    ) {
      matches.push(node);
    }
  }
  matches.sort((left, right) => left - right);
  return Uint32Array.from(matches);
}

export function selectFullNetworkSemanticLevel(
  projectedNodePixels: number,
  previous: FullNetworkSemanticLevel | undefined,
  configuration: FullNetworkRenderConfiguration = defaultFullNetworkRenderConfiguration,
): FullNetworkSemanticLevel {
  nonNegativeFinite(projectedNodePixels, 'projectedNodePixels');
  validateRenderConfiguration(configuration);
  if (previous === 'overview') {
    if (projectedNodePixels >= configuration.networkToDetailPixels) {
      return 'detail';
    }
    return projectedNodePixels >= configuration.overviewToNetworkPixels
      ? 'network'
      : 'overview';
  }
  if (previous === 'network') {
    if (projectedNodePixels <= configuration.networkToOverviewPixels) {
      return 'overview';
    }
    return projectedNodePixels >= configuration.networkToDetailPixels
      ? 'detail'
      : 'network';
  }
  if (previous === 'detail') {
    if (projectedNodePixels <= configuration.networkToOverviewPixels) {
      return 'overview';
    }
    return projectedNodePixels <= configuration.detailToNetworkPixels
      ? 'network'
      : 'detail';
  }
  if (projectedNodePixels < configuration.overviewToNetworkPixels) {
    return 'overview';
  }
  return projectedNodePixels >= configuration.networkToDetailPixels
    ? 'detail'
    : 'network';
}

export function fullNetworkWorldViewport(
  camera: FullNetworkRenderCamera,
  overscanPixels: number,
): FullNetworkViewport {
  validateCamera(camera);
  nonNegativeFinite(overscanPixels, 'overscanPixels');
  const overscan = overscanPixels / camera.scale;
  return {
    minX: -camera.offsetX / camera.scale - overscan,
    minY: -camera.offsetY / camera.scale - overscan,
    maxX: (camera.viewportWidth - camera.offsetX) / camera.scale + overscan,
    maxY: (camera.viewportHeight - camera.offsetY) / camera.scale + overscan,
  };
}

function incidentEdgesForNodes(
  dataset: FullNetworkRenderDataset,
  nodeIndexes: readonly number[],
): Uint32Array {
  const edges: number[] = [];
  const seen = new Set<number>();
  for (const node of nodeIndexes) {
    if (
      !Number.isSafeInteger(node) ||
      node < 0 ||
      node >= dataset.overview.nodeCount
    ) {
      throw new RangeError(`Full-network emphasis node ${node} is invalid`);
    }
    const start = typedValue(dataset.incidents.offsets, node, 'incident start');
    const end = typedValue(dataset.incidents.offsets, node + 1, 'incident end');
    for (let position = start; position < end; position += 1) {
      const edge = typedValue(
        dataset.incidents.edgeIndexes,
        position,
        'incident edge',
      );
      if (!seen.has(edge)) {
        seen.add(edge);
        edges.push(edge);
      }
    }
  }
  edges.sort((left, right) => left - right);
  return Uint32Array.from(edges);
}

function transitionForLevel(
  previous: FullNetworkSemanticLevel | undefined,
  next: FullNetworkSemanticLevel,
  reducedMotion: boolean,
): FullNetworkLevelTransition {
  if (!previous || previous === next) return { kind: 'stable', level: next };
  return reducedMotion
    ? { kind: 'cut', from: previous, to: next }
    : { kind: 'crossfade', from: previous, to: next };
}

export function createFullNetworkRenderPlan(
  input: Readonly<{
    dataset: FullNetworkRenderDataset;
    camera: FullNetworkRenderCamera;
    previousLevel?: FullNetworkSemanticLevel;
    currentCardId?: CardId | null;
    selectedCardId?: CardId | null;
    reducedMotion: boolean;
    configuration?: FullNetworkRenderConfiguration;
  }>,
): FullNetworkRenderPlan {
  const configuration =
    input.configuration ?? defaultFullNetworkRenderConfiguration;
  validateRenderConfiguration(configuration);
  validateCamera(input.camera);
  const nodeDiameter =
    Math.min(
      input.dataset.routing.routingConfiguration.nodeHalfWidth,
      input.dataset.routing.routingConfiguration.nodeHalfHeight,
    ) * 2;
  const projectedNodePixels = nodeDiameter * input.camera.scale;
  const level = selectFullNetworkSemanticLevel(
    projectedNodePixels,
    input.previousLevel,
    configuration,
  );
  const worldViewport = fullNetworkWorldViewport(
    input.camera,
    configuration.detailOverscanPixels,
  );
  const visibleNodeIndexes =
    level === 'overview'
      ? new Uint32Array()
      : queryFullNetworkNodes(input.dataset, worldViewport);
  const visibleEdgeIndexes =
    level === 'overview'
      ? new Uint32Array()
      : queryFullNetworkRoutes(input.dataset.routing, worldViewport);
  const currentNodeIndex = input.currentCardId
    ? (input.dataset.nodeIndexesByCardId.get(input.currentCardId) ?? null)
    : null;
  const selectedNodeIndex = input.selectedCardId
    ? (input.dataset.nodeIndexesByCardId.get(input.selectedCardId) ?? null)
    : null;
  const emphasizedNodeIndexes: number[] = [];
  for (const node of [currentNodeIndex, selectedNodeIndex]) {
    if (node !== null && !emphasizedNodeIndexes.includes(node)) {
      emphasizedNodeIndexes.push(node);
    }
  }
  emphasizedNodeIndexes.sort((left, right) => left - right);
  const currentIncidentEdgeIndexes = incidentEdgesForNodes(
    input.dataset,
    currentNodeIndex === null ? [] : [currentNodeIndex],
  );
  const selectedIncidentEdgeIndexes = incidentEdgesForNodes(
    input.dataset,
    selectedNodeIndex === null ? [] : [selectedNodeIndex],
  );
  const emphasizedEdgeIndexes = incidentEdgesForNodes(
    input.dataset,
    emphasizedNodeIndexes,
  );
  const transition = transitionForLevel(
    input.previousLevel,
    level,
    input.reducedMotion,
  );
  return {
    planKey: `${input.dataset.datasetKey}:render-v${configuration.version}:${configuration.overviewToNetworkPixels}:${configuration.networkToOverviewPixels}:${configuration.networkToDetailPixels}:${configuration.detailToNetworkPixels}:${configuration.detailOverscanPixels}:${level}:${transition.kind}:${input.camera.offsetX}:${input.camera.offsetY}:${input.camera.scale}:${input.camera.viewportWidth}:${input.camera.viewportHeight}:${currentNodeIndex ?? ''}:${selectedNodeIndex ?? ''}`,
    datasetKey: input.dataset.datasetKey,
    level,
    transition,
    camera: { ...input.camera },
    worldViewport,
    projectedNodePixels,
    overviewNodeCount: input.dataset.overview.nodeCount,
    overviewEdgeCount: input.dataset.overview.edgeCount,
    visibleNodeIndexes,
    visibleEdgeIndexes,
    currentNodeIndex,
    selectedNodeIndex,
    currentIncidentEdgeIndexes,
    selectedIncidentEdgeIndexes,
    emphasizedNodeIndexes: Uint32Array.from(emphasizedNodeIndexes),
    emphasizedEdgeIndexes,
    labelsVisible: level === 'detail',
    directionsVisible: level !== 'overview',
  };
}

export function fullNetworkRendererGeometryBytes(
  dataset: FullNetworkRenderDataset,
): FullNetworkRendererGeometryBytes {
  const overviewEdgePositions = dataset.overview.edgePositions.byteLength;
  const overviewNodePositions = dataset.overview.nodePositions.byteLength;
  const nodeSpatialIndex = dataset.nodes.nodeIndexesByX.byteLength;
  const incidentOffsets = dataset.incidents.offsets.byteLength;
  const incidentEdgeIndexes = dataset.incidents.edgeIndexes.byteLength;
  return {
    overviewEdgePositions,
    overviewNodePositions,
    nodeSpatialIndex,
    incidentOffsets,
    incidentEdgeIndexes,
    total:
      overviewEdgePositions +
      overviewNodePositions +
      nodeSpatialIndex +
      incidentOffsets +
      incidentEdgeIndexes,
  };
}

export function fitFullNetworkRenderCamera(
  input: Readonly<{
    dataset: FullNetworkRenderDataset;
    viewportWidth: number;
    viewportHeight: number;
    paddingPixels: number;
  }>,
): FullNetworkRenderCamera {
  positiveFinite(input.viewportWidth, 'viewportWidth');
  positiveFinite(input.viewportHeight, 'viewportHeight');
  nonNegativeFinite(input.paddingPixels, 'paddingPixels');
  const availableWidth = Math.max(
    1,
    input.viewportWidth - input.paddingPixels * 2,
  );
  const availableHeight = Math.max(
    1,
    input.viewportHeight - input.paddingPixels * 2,
  );
  const worldWidth = Math.max(1, input.dataset.routing.layout.width);
  const worldHeight = Math.max(1, input.dataset.routing.layout.height);
  const scale = Math.min(
    availableWidth / worldWidth,
    availableHeight / worldHeight,
  );
  return {
    offsetX: (input.viewportWidth - worldWidth * scale) / 2,
    offsetY: (input.viewportHeight - worldHeight * scale) / 2,
    scale,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
  };
}
