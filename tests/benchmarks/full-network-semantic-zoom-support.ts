import {
  buildConnectionsGraph,
  type ConnectionsGraph,
} from '@/lib/domain/graph';
import { parseCardId } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';
import { encodeSyncV2StoredCard } from '@/server/sync-v2/content-codec';

export type FullNetworkNumericGraph = Readonly<{
  name: string;
  nodeCount: number;
  sources: Uint32Array;
  targets: Uint32Array;
}>;

export type FullNetworkPlacementCandidate =
  | 'identity-serpentine'
  | 'component-bfs-serpentine'
  | 'component-dfs-serpentine';

export type FullNetworkPlacement = Readonly<{
  candidate: FullNetworkPlacementCandidate;
  x: Float64Array;
  y: Float64Array;
  width: number;
  height: number;
  componentCount: number;
}>;

export type FullNetworkCandidateScore = Readonly<{
  candidate: FullNetworkPlacementCandidate;
  graphCount: number;
  hardViolations: number;
  worstP95NormalizedLinkLength: number;
  worstMaximumNormalizedLinkLength: number;
  sampledCrossings: number;
  sampledNodeIntrusions: number;
}>;

export type FullNetworkCandidateDecision = Readonly<{
  selected: FullNetworkPlacementCandidate;
  priority:
    | 'hard-geometry'
    | 'worst-p95-link-length'
    | 'worst-maximum-link-length'
    | 'sampled-crossings'
    | 'sampled-node-intrusions'
    | 'stable-name';
  scores: readonly FullNetworkCandidateScore[];
}>;

export type FullNetworkBenchmarkArtifactContract = Readonly<{
  issue: number;
  branchPoint: string;
  displaySampling: boolean;
  selectedCandidate: FullNetworkPlacementCandidate;
  representative: Readonly<{ nodes: number; directedEdges: number }>;
  dense: Readonly<{ nodes: number; directedEdges: number }>;
  renderers: readonly Readonly<{
    graph: string;
    nodeCount: number;
    edgeCount: number;
    offscreenCanvas: boolean;
    workerWebgl2: boolean;
    webgl2: boolean;
    retainedGeometryBytes: number;
  }>[];
}>;

export type FullNetworkPlacementMetrics = Readonly<{
  candidate: FullNetworkPlacement['candidate'];
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  width: number;
  height: number;
  area: number;
  duplicatePositions: number;
  nonFiniteValues: number;
  totalLinkLength: number;
  medianLinkLength: number;
  p95LinkLength: number;
  maximumLinkLength: number;
  medianNormalizedLinkLength: number;
  p95NormalizedLinkLength: number;
  maximumNormalizedLinkLength: number;
  crossingSample: Readonly<{
    edgeCount: number;
    crossings: number;
  }>;
  nodeIntrusionSample: Readonly<{
    edgeCount: number;
    nodesChecked: number;
    intrusions: number;
  }>;
}>;

const sampleCardId = parseCardId('01991f20-61d2-7000-8000-000000000001');
const defaultCellWidth = 16;
const defaultCellHeight = 12;
const componentGap = 48;

function objectValue(input: unknown, label: string): object {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  return input;
}

function field(input: object, key: string): unknown {
  return Reflect.get(input, key);
}

function numberField(input: object, key: string, label: string): number {
  const value = field(input, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label}.${key} must be finite`);
  }
  return value;
}

function stringField(input: object, key: string, label: string): string {
  const value = field(input, key);
  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
}

function booleanField(input: object, key: string, label: string): boolean {
  const value = field(input, key);
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label}.${key} must be a boolean`);
  }
  return value;
}

function placementCandidate(value: unknown): FullNetworkPlacementCandidate {
  if (
    value !== 'identity-serpentine' &&
    value !== 'component-bfs-serpentine' &&
    value !== 'component-dfs-serpentine'
  ) {
    throw new TypeError('Artifact selected an unknown placement candidate');
  }
  return value;
}

function typedValue(
  values: Uint32Array | Int32Array | Float64Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function integer(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

export function maximumUniqueLinksPerCardWithinPlaintextLimit(
  plaintextByteLimit = 8_192,
  maximumCards = 10_000,
): Readonly<{ links: number; bytes: number; nextBytes: number }> {
  integer(plaintextByteLimit, 'plaintextByteLimit', 1);
  integer(maximumCards, 'maximumCards', 1);
  const encodedBytes = (links: number): number =>
    encodeSyncV2StoredCard({
      title: '',
      body: Array.from({ length: links }, () => ({
        type: 'link' as const,
        targetCardId: sampleCardId,
      })),
      createdAt: 0,
      updatedAt: 0,
    }).byteLength;

  let lower = 0;
  let upper = Math.min(10_000, maximumCards - 1);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (encodedBytes(middle) <= plaintextByteLimit) lower = middle;
    else upper = middle - 1;
  }
  return {
    links: lower,
    bytes: encodedBytes(lower),
    nextBytes: encodedBytes(lower + 1),
  };
}

export function numericGraphFromConnectionsGraph(
  name: string,
  graph: ConnectionsGraph,
): FullNetworkNumericGraph {
  const nodeIndex = new Map(
    graph.nodes.map(({ card }, index) => [card.id, index]),
  );
  const sources = new Uint32Array(graph.edges.length);
  const targets = new Uint32Array(graph.edges.length);
  for (const [index, edge] of graph.edges.entries()) {
    const source = nodeIndex.get(edge.sourceCardId);
    const target = nodeIndex.get(edge.targetCardId);
    if (source === undefined) {
      throw new Error(`Missing source ${edge.sourceCardId}`);
    }
    if (target === undefined) {
      throw new Error(`Missing target ${edge.targetCardId}`);
    }
    sources[index] = source;
    targets[index] = target;
  }
  return { name, nodeCount: graph.nodes.length, sources, targets };
}

export function representativeFullNetworkGraph(
  cards: CardRecord[],
): FullNetworkNumericGraph {
  return numericGraphFromConnectionsGraph(
    'representative-10k',
    buildConnectionsGraph(cards),
  );
}

export function denseFullNetworkGraph(
  nodeCount: number,
  linksPerNode: number,
): FullNetworkNumericGraph {
  integer(nodeCount, 'nodeCount', 0);
  integer(linksPerNode, 'linksPerNode', 0);
  if (nodeCount === 0 && linksPerNode > 0) {
    throw new RangeError('An empty graph cannot contain links');
  }
  if (linksPerNode >= nodeCount && nodeCount > 0) {
    throw new RangeError('linksPerNode must be smaller than nodeCount');
  }
  const edgeCount = nodeCount * linksPerNode;
  const sources = new Uint32Array(edgeCount);
  const targets = new Uint32Array(edgeCount);
  const stride = nodeCount <= 2 ? 1 : 7_919 % nodeCount || 1;
  let edgeIndex = 0;
  for (let source = 0; source < nodeCount; source += 1) {
    const used = new Set<number>();
    for (let link = 0; link < linksPerNode; link += 1) {
      let target = (source + 1 + link * stride) % nodeCount;
      while (target === source || used.has(target)) {
        target = (target + 1) % nodeCount;
      }
      used.add(target);
      sources[edgeIndex] = source;
      targets[edgeIndex] = target;
      edgeIndex += 1;
    }
  }
  return {
    name: `dense-${nodeCount}-${linksPerNode}`,
    nodeCount,
    sources,
    targets,
  };
}

function numericGraphFromEdges(
  name: string,
  nodeCount: number,
  edges: readonly (readonly [number, number])[],
): FullNetworkNumericGraph {
  integer(nodeCount, 'nodeCount', 0);
  const sources = new Uint32Array(edges.length);
  const targets = new Uint32Array(edges.length);
  for (const [index, [source, target]] of edges.entries()) {
    integer(source, `edges[${index}].source`, 0);
    integer(target, `edges[${index}].target`, 0);
    if (source >= nodeCount || target >= nodeCount) {
      throw new RangeError(`Edge ${index} references an unknown node`);
    }
    sources[index] = source;
    targets[index] = target;
  }
  return { name, nodeCount, sources, targets };
}

export function semanticZoomFixtureCorpus(): readonly FullNetworkNumericGraph[] {
  const chain = Array.from(
    { length: 31 },
    (_, node) => [node, node + 1] as const,
  );
  const cycle = [...chain, [31, 0] as const];
  const star = Array.from({ length: 255 }, (_, node) => [0, node + 1] as const);
  const highDegree = Array.from(
    { length: 116 },
    (_, node) => [0, node + 1] as const,
  );
  return [
    numericGraphFromEdges('empty', 0, []),
    numericGraphFromEdges('single', 1, []),
    numericGraphFromEdges('all-isolated', 10, []),
    numericGraphFromEdges('disconnected', 8, [
      [0, 1],
      [2, 3],
      [3, 4],
      [5, 6],
    ]),
    numericGraphFromEdges('chain', 32, chain),
    numericGraphFromEdges('cycle', 32, cycle),
    numericGraphFromEdges('self', 3, [[1, 1]]),
    numericGraphFromEdges('mutual', 3, [
      [0, 1],
      [1, 0],
    ]),
    numericGraphFromEdges('star', 256, star),
    numericGraphFromEdges('high-degree', 10_000, highDegree),
  ];
}

type Component = Readonly<{
  nodes: number[];
  order: number[];
  columns: number;
  rows: number;
  width: number;
  height: number;
}>;

type GraphIndex = Readonly<{
  degrees: Uint32Array;
  offsets: Uint32Array;
  neighbors: Uint32Array;
  components: number[][];
}>;

function createGraphIndex(graph: FullNetworkNumericGraph): GraphIndex {
  const parent = new Int32Array(graph.nodeCount);
  const rank = new Uint8Array(graph.nodeCount);
  const degrees = new Uint32Array(graph.nodeCount);
  for (let node = 0; node < graph.nodeCount; node += 1) parent[node] = node;

  const find = (node: number): number => {
    let root = node;
    while (typedValue(parent, root, 'parent') !== root) {
      root = typedValue(parent, root, 'parent');
    }
    let current = node;
    while (typedValue(parent, current, 'parent') !== current) {
      const next = typedValue(parent, current, 'parent');
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = rank[leftRoot] ?? 0;
    const rightRank = rank[rightRoot] ?? 0;
    if (leftRank < rightRank) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parent[rightRoot] = leftRoot;
    if (leftRank === rightRank) rank[leftRoot] = leftRank + 1;
  };

  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const source = typedValue(graph.sources, edge, 'source');
    const target = typedValue(graph.targets, edge, 'target');
    if (source >= graph.nodeCount || target >= graph.nodeCount) {
      throw new RangeError(`Edge ${edge} references an unknown node`);
    }
    degrees[source] = typedValue(degrees, source, 'degree') + 1;
    degrees[target] = typedValue(degrees, target, 'degree') + 1;
    union(source, target);
  }

  const offsets = new Uint32Array(graph.nodeCount + 1);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    offsets[node + 1] =
      typedValue(offsets, node, 'offset') + typedValue(degrees, node, 'degree');
  }
  const neighbors = new Uint32Array(
    typedValue(offsets, graph.nodeCount, 'final offset'),
  );
  const cursors = new Uint32Array(offsets);
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const source = typedValue(graph.sources, edge, 'source');
    const target = typedValue(graph.targets, edge, 'target');
    const sourceCursor = typedValue(cursors, source, 'source cursor');
    const targetCursor = typedValue(cursors, target, 'target cursor');
    neighbors[sourceCursor] = target;
    neighbors[targetCursor] = source;
    cursors[source] = sourceCursor + 1;
    cursors[target] = targetCursor + 1;
  }

  const byRoot = new Map<number, number[]>();
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const root = find(node);
    const nodes = byRoot.get(root) ?? [];
    nodes.push(node);
    byRoot.set(root, nodes);
  }
  const components = [...byRoot.values()].sort(
    (left, right) =>
      right.length - left.length || (left[0] ?? 0) - (right[0] ?? 0),
  );
  return { degrees, offsets, neighbors, components };
}

function breadthFirstOrder(
  nodes: readonly number[],
  index: GraphIndex,
  nodeCount: number,
): number[] {
  if (nodes.length === 0) return [];
  const start = [...nodes].sort(
    (left, right) =>
      typedValue(index.degrees, right, 'degree') -
        typedValue(index.degrees, left, 'degree') || left - right,
  )[0];
  if (start === undefined) throw new Error('Component omitted its start node');
  const inComponent = new Uint8Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  for (const node of nodes) inComponent[node] = 1;
  const queue: number[] = [start];
  visited[start] = 1;
  for (let position = 0; position < queue.length; position += 1) {
    const node = queue[position];
    if (node === undefined)
      throw new Error(`BFS omitted queue node ${position}`);
    const first = typedValue(index.offsets, node, 'first neighbor offset');
    const last = typedValue(index.offsets, node + 1, 'last neighbor offset');
    const candidates: number[] = [];
    for (let cursor = first; cursor < last; cursor += 1) {
      const neighbor = typedValue(index.neighbors, cursor, 'neighbor');
      if (inComponent[neighbor] !== 1 || visited[neighbor] === 1) continue;
      candidates.push(neighbor);
    }
    candidates.sort(
      (left, right) =>
        typedValue(index.degrees, right, 'degree') -
          typedValue(index.degrees, left, 'degree') || left - right,
    );
    for (const candidate of candidates) {
      if (visited[candidate] === 1) continue;
      visited[candidate] = 1;
      queue.push(candidate);
    }
  }
  for (const node of nodes) {
    if (visited[node] !== 1) queue.push(node);
  }
  return queue;
}

function depthFirstOrder(
  nodes: readonly number[],
  index: GraphIndex,
  nodeCount: number,
): number[] {
  const start = [...nodes].sort((left, right) => left - right)[0];
  if (start === undefined) return [];
  const inComponent = new Uint8Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  for (const node of nodes) inComponent[node] = 1;
  const stack: number[] = [start];
  const order: number[] = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || visited[node] === 1) continue;
    visited[node] = 1;
    order.push(node);
    const first = typedValue(index.offsets, node, 'first neighbor offset');
    const last = typedValue(index.offsets, node + 1, 'last neighbor offset');
    const candidates: number[] = [];
    for (let cursor = first; cursor < last; cursor += 1) {
      const neighbor = typedValue(index.neighbors, cursor, 'neighbor');
      if (inComponent[neighbor] === 1 && visited[neighbor] !== 1) {
        candidates.push(neighbor);
      }
    }
    candidates.sort((left, right) => right - left);
    stack.push(...candidates);
  }
  for (const node of nodes) {
    if (visited[node] !== 1) order.push(node);
  }
  return order;
}

function componentLayouts(
  graph: FullNetworkNumericGraph,
  candidate: FullNetworkPlacement['candidate'],
): Component[] {
  const index = createGraphIndex(graph);
  return index.components.map((nodes) => {
    const order =
      candidate === 'component-bfs-serpentine'
        ? breadthFirstOrder(nodes, index, graph.nodeCount)
        : candidate === 'component-dfs-serpentine'
          ? depthFirstOrder(nodes, index, graph.nodeCount)
          : [...nodes];
    const columns = Math.max(
      1,
      Math.ceil(
        Math.sqrt((order.length * defaultCellHeight) / defaultCellWidth),
      ),
    );
    const rows = Math.max(1, Math.ceil(order.length / columns));
    return {
      nodes,
      order,
      columns,
      rows,
      width: columns * defaultCellWidth,
      height: rows * defaultCellHeight,
    };
  });
}

export function placeFullNetwork(
  graph: FullNetworkNumericGraph,
  candidate: FullNetworkPlacement['candidate'],
): FullNetworkPlacement {
  const components = componentLayouts(graph, candidate);
  const x = new Float64Array(graph.nodeCount);
  const y = new Float64Array(graph.nodeCount);
  const totalArea = components.reduce(
    (sum, component) => sum + component.width * component.height,
    0,
  );
  const targetShelfWidth = Math.max(
    defaultCellWidth,
    Math.sqrt(totalArea) * 1.25,
  );
  let originX = 0;
  let originY = 0;
  let shelfHeight = 0;
  let maximumX = 0;
  for (const component of components) {
    if (originX > 0 && originX + component.width > targetShelfWidth) {
      originX = 0;
      originY += shelfHeight + componentGap;
      shelfHeight = 0;
    }
    for (const [position, node] of component.order.entries()) {
      const row = Math.floor(position / component.columns);
      const offset = position % component.columns;
      const column = row % 2 === 0 ? offset : component.columns - 1 - offset;
      x[node] = originX + column * defaultCellWidth;
      y[node] = originY + row * defaultCellHeight;
    }
    originX += component.width + componentGap;
    shelfHeight = Math.max(shelfHeight, component.height);
    maximumX = Math.max(maximumX, originX - componentGap);
  }
  const height = components.length === 0 ? 0 : originY + shelfHeight;
  return {
    candidate,
    x,
    y,
    width: maximumX,
    height,
    componentCount: components.length,
  };
}

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1),
  );
  const value = sorted[index];
  if (value === undefined) throw new Error(`Missing percentile ${proportion}`);
  return value;
}

function properIntersection(
  firstStartX: number,
  firstStartY: number,
  firstEndX: number,
  firstEndY: number,
  secondStartX: number,
  secondStartY: number,
  secondEndX: number,
  secondEndY: number,
): boolean {
  const firstX = firstEndX - firstStartX;
  const firstY = firstEndY - firstStartY;
  const secondX = secondEndX - secondStartX;
  const secondY = secondEndY - secondStartY;
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < 1e-9) return false;
  const offsetX = secondStartX - firstStartX;
  const offsetY = secondStartY - firstStartY;
  const firstProgress = (offsetX * secondY - offsetY * secondX) / denominator;
  const secondProgress = (offsetX * firstY - offsetY * firstX) / denominator;
  return (
    firstProgress > 1e-9 &&
    firstProgress < 1 - 1e-9 &&
    secondProgress > 1e-9 &&
    secondProgress < 1 - 1e-9
  );
}

function sampledCrossings(
  graph: FullNetworkNumericGraph,
  placement: FullNetworkPlacement,
  maximumEdges = 2_000,
): Readonly<{ edgeCount: number; crossings: number }> {
  const edgeCount = Math.min(maximumEdges, graph.sources.length);
  if (edgeCount < 2) return { edgeCount, crossings: 0 };
  const edgeIndexes = sampledIndexes(graph.sources.length, edgeCount);
  let crossings = 0;
  for (let left = 0; left < edgeIndexes.length; left += 1) {
    const leftEdge = edgeIndexes[left];
    if (leftEdge === undefined) throw new Error(`Missing sampled edge ${left}`);
    const leftSource = typedValue(graph.sources, leftEdge, 'left source');
    const leftTarget = typedValue(graph.targets, leftEdge, 'left target');
    for (let right = left + 1; right < edgeIndexes.length; right += 1) {
      const rightEdge = edgeIndexes[right];
      if (rightEdge === undefined) {
        throw new Error(`Missing sampled edge ${right}`);
      }
      const rightSource = typedValue(graph.sources, rightEdge, 'right source');
      const rightTarget = typedValue(graph.targets, rightEdge, 'right target');
      if (
        leftSource === rightSource ||
        leftSource === rightTarget ||
        leftTarget === rightSource ||
        leftTarget === rightTarget
      ) {
        continue;
      }
      if (
        properIntersection(
          typedValue(placement.x, leftSource, 'left source x'),
          typedValue(placement.y, leftSource, 'left source y'),
          typedValue(placement.x, leftTarget, 'left target x'),
          typedValue(placement.y, leftTarget, 'left target y'),
          typedValue(placement.x, rightSource, 'right source x'),
          typedValue(placement.y, rightSource, 'right source y'),
          typedValue(placement.x, rightTarget, 'right target x'),
          typedValue(placement.y, rightTarget, 'right target y'),
        )
      ) {
        crossings += 1;
      }
    }
  }
  return { edgeCount, crossings };
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = Math.abs(left);
  let second = Math.abs(right);
  while (second !== 0) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

function sampledIndexes(length: number, count: number): number[] {
  if (count === 0) return [];
  let stride = Math.min(104_729, Math.max(1, length - 1));
  while (greatestCommonDivisor(stride, length) !== 1) stride -= 1;
  return Array.from(
    { length: count },
    (_, index) => (17 + index * stride) % length,
  );
}

function squaredDistanceToSegment(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) {
    return (pointX - startX) ** 2 + (pointY - startY) ** 2;
  }
  const progress = Math.max(
    0,
    Math.min(
      1,
      ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / squaredLength,
    ),
  );
  const closestX = startX + progress * deltaX;
  const closestY = startY + progress * deltaY;
  return (pointX - closestX) ** 2 + (pointY - closestY) ** 2;
}

function sampledNodeIntrusions(
  graph: FullNetworkNumericGraph,
  placement: FullNetworkPlacement,
  maximumEdges = 200,
): Readonly<{
  edgeCount: number;
  nodesChecked: number;
  intrusions: number;
}> {
  const edgeCount = Math.min(maximumEdges, graph.sources.length);
  if (edgeCount === 0 || graph.nodeCount < 3) {
    return { edgeCount, nodesChecked: 0, intrusions: 0 };
  }
  let nodesChecked = 0;
  let intrusions = 0;
  for (const edge of sampledIndexes(graph.sources.length, edgeCount)) {
    const source = typedValue(graph.sources, edge, 'intrusion source');
    const target = typedValue(graph.targets, edge, 'intrusion target');
    const sourceX = typedValue(placement.x, source, 'intrusion source x');
    const sourceY = typedValue(placement.y, source, 'intrusion source y');
    const targetX = typedValue(placement.x, target, 'intrusion target x');
    const targetY = typedValue(placement.y, target, 'intrusion target y');
    for (let node = 0; node < graph.nodeCount; node += 1) {
      if (node === source || node === target) continue;
      nodesChecked += 1;
      if (
        squaredDistanceToSegment(
          typedValue(placement.x, node, 'intrusion node x'),
          typedValue(placement.y, node, 'intrusion node y'),
          sourceX,
          sourceY,
          targetX,
          targetY,
        ) < 9
      ) {
        intrusions += 1;
      }
    }
  }
  return { edgeCount, nodesChecked, intrusions };
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

export function measureFullNetworkPlacement(
  graph: FullNetworkNumericGraph,
  placement: FullNetworkPlacement,
): FullNetworkPlacementMetrics {
  if (
    placement.x.length !== graph.nodeCount ||
    placement.y.length !== graph.nodeCount
  ) {
    throw new RangeError('Placement must contain every graph node');
  }
  const positions = new Set<string>();
  let nonFiniteValues = 0;
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const x = typedValue(placement.x, node, 'node x');
    const y = typedValue(placement.y, node, 'node y');
    if (!Number.isFinite(x) || !Number.isFinite(y)) nonFiniteValues += 1;
    positions.add(`${x}:${y}`);
  }
  const distances = Array.from({ length: graph.sources.length }, () => 0);
  let total = 0;
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const source = typedValue(graph.sources, edge, 'source');
    const target = typedValue(graph.targets, edge, 'target');
    const distance = Math.hypot(
      typedValue(placement.x, target, 'target x') -
        typedValue(placement.x, source, 'source x'),
      typedValue(placement.y, target, 'target y') -
        typedValue(placement.y, source, 'source y'),
    );
    distances[edge] = distance;
    total += distance;
  }
  distances.sort((left, right) => left - right);
  const area = placement.width * placement.height;
  const normalization =
    graph.nodeCount === 0 || area === 0 ? 1 : Math.sqrt(area / graph.nodeCount);
  const median = percentile(distances, 0.5);
  const p95 = percentile(distances, 0.95);
  const maximum = distances.at(-1) ?? 0;
  return {
    candidate: placement.candidate,
    nodeCount: graph.nodeCount,
    edgeCount: graph.sources.length,
    componentCount: placement.componentCount,
    width: rounded(placement.width),
    height: rounded(placement.height),
    area: rounded(area),
    duplicatePositions: graph.nodeCount - positions.size,
    nonFiniteValues,
    totalLinkLength: rounded(total),
    medianLinkLength: rounded(median),
    p95LinkLength: rounded(p95),
    maximumLinkLength: rounded(maximum),
    medianNormalizedLinkLength: rounded(median / normalization),
    p95NormalizedLinkLength: rounded(p95 / normalization),
    maximumNormalizedLinkLength: rounded(maximum / normalization),
    crossingSample: sampledCrossings(graph, placement),
    nodeIntrusionSample: sampledNodeIntrusions(graph, placement),
  };
}

export function numericGraphChecksum(graph: FullNetworkNumericGraph): number {
  let checksum = graph.nodeCount * 31 + graph.sources.length;
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    checksum =
      (checksum * 33 +
        typedValue(graph.sources, edge, 'checksum source') * 17 +
        typedValue(graph.targets, edge, 'checksum target')) >>>
      0;
  }
  return checksum;
}

export function selectFullNetworkPlacementCandidate(
  measurements: readonly Readonly<{
    graph: string;
    metrics: FullNetworkPlacementMetrics;
  }>[],
): FullNetworkCandidateDecision {
  if (measurements.length === 0) {
    throw new RangeError('Candidate selection requires measurements');
  }
  const graphNames = new Set(measurements.map(({ graph }) => graph));
  const byCandidate = new Map<
    FullNetworkPlacementCandidate,
    Readonly<{ graph: string; metrics: FullNetworkPlacementMetrics }>[]
  >();
  for (const measurement of measurements) {
    const { metrics } = measurement;
    const entries = byCandidate.get(metrics.candidate) ?? [];
    entries.push(measurement);
    byCandidate.set(metrics.candidate, entries);
  }
  const scores = [...byCandidate.entries()].map(
    ([candidate, entries]): FullNetworkCandidateScore => {
      const candidateGraphs = new Set(entries.map(({ graph }) => graph));
      if (
        entries.length !== graphNames.size ||
        candidateGraphs.size !== graphNames.size ||
        [...graphNames].some((graph) => !candidateGraphs.has(graph))
      ) {
        throw new Error(`${candidate} omitted a benchmark graph`);
      }
      const metrics = entries.map((entry) => entry.metrics);
      return {
        candidate,
        graphCount: metrics.length,
        hardViolations: metrics.reduce(
          (total, measurement) =>
            total +
            measurement.nonFiniteValues +
            measurement.duplicatePositions,
          0,
        ),
        worstP95NormalizedLinkLength: Math.max(
          ...metrics.map((measurement) => measurement.p95NormalizedLinkLength),
        ),
        worstMaximumNormalizedLinkLength: Math.max(
          ...metrics.map(
            (measurement) => measurement.maximumNormalizedLinkLength,
          ),
        ),
        sampledCrossings: metrics.reduce(
          (total, measurement) => total + measurement.crossingSample.crossings,
          0,
        ),
        sampledNodeIntrusions: metrics.reduce(
          (total, measurement) =>
            total + measurement.nodeIntrusionSample.intrusions,
          0,
        ),
      };
    },
  );
  const comparisons: readonly Readonly<{
    priority: FullNetworkCandidateDecision['priority'];
    value: (score: FullNetworkCandidateScore) => number | string;
  }>[] = [
    { priority: 'hard-geometry', value: (score) => score.hardViolations },
    {
      priority: 'worst-p95-link-length',
      value: (score) => score.worstP95NormalizedLinkLength,
    },
    {
      priority: 'worst-maximum-link-length',
      value: (score) => score.worstMaximumNormalizedLinkLength,
    },
    { priority: 'sampled-crossings', value: (score) => score.sampledCrossings },
    {
      priority: 'sampled-node-intrusions',
      value: (score) => score.sampledNodeIntrusions,
    },
    { priority: 'stable-name', value: (score) => score.candidate },
  ];
  const ranked = [...scores].sort((left, right) => {
    for (const comparison of comparisons) {
      const leftValue = comparison.value(left);
      const rightValue = comparison.value(right);
      if (leftValue === rightValue) continue;
      return leftValue < rightValue ? -1 : 1;
    }
    return 0;
  });
  const selected = ranked[0];
  if (!selected) throw new Error('Candidate selection produced no result');
  const runnerUp = ranked[1];
  const priority =
    comparisons.find(
      (comparison) =>
        runnerUp === undefined ||
        comparison.value(selected) !== comparison.value(runnerUp),
    )?.priority ?? 'stable-name';
  return { selected: selected.candidate, priority, scores };
}

export function decodeFullNetworkBenchmarkArtifactContract(
  input: unknown,
): FullNetworkBenchmarkArtifactContract {
  const artifact = objectValue(input, 'artifact');
  const policy = objectValue(field(artifact, 'policy'), 'artifact.policy');
  const graphs = objectValue(field(artifact, 'graphs'), 'artifact.graphs');
  const representative = objectValue(
    field(graphs, 'representative'),
    'artifact.graphs.representative',
  );
  const dense = objectValue(field(graphs, 'dense'), 'artifact.graphs.dense');
  const decision = objectValue(
    field(artifact, 'candidateDecision'),
    'artifact.candidateDecision',
  );
  const rendererValue = field(artifact, 'renderer');
  if (!Array.isArray(rendererValue)) {
    throw new TypeError('artifact.renderer must be an array');
  }
  const renderers = rendererValue.map((value, index) => {
    const label = `artifact.renderer[${index}]`;
    const renderer = objectValue(value, label);
    const capability = objectValue(
      field(renderer, 'workerCapability'),
      `${label}.workerCapability`,
    );
    const webgl = objectValue(field(renderer, 'webgl2'), `${label}.webgl2`);
    return {
      graph: stringField(renderer, 'graph', label),
      nodeCount: numberField(renderer, 'nodeCount', label),
      edgeCount: numberField(renderer, 'edgeCount', label),
      offscreenCanvas: booleanField(
        capability,
        'offscreenCanvas',
        `${label}.workerCapability`,
      ),
      workerWebgl2: booleanField(
        capability,
        'webgl2',
        `${label}.workerCapability`,
      ),
      webgl2: booleanField(webgl, 'supported', `${label}.webgl2`),
      retainedGeometryBytes: numberField(
        webgl,
        'retainedGeometryBytes',
        `${label}.webgl2`,
      ),
    };
  });
  return {
    issue: numberField(artifact, 'issue', 'artifact'),
    branchPoint: stringField(artifact, 'branchPoint', 'artifact'),
    displaySampling: booleanField(policy, 'displaySampling', 'artifact.policy'),
    selectedCandidate: placementCandidate(field(decision, 'selected')),
    representative: {
      nodes: numberField(
        representative,
        'nodes',
        'artifact.graphs.representative',
      ),
      directedEdges: numberField(
        representative,
        'directedEdges',
        'artifact.graphs.representative',
      ),
    },
    dense: {
      nodes: numberField(dense, 'nodes', 'artifact.graphs.dense'),
      directedEdges: numberField(
        dense,
        'directedEdges',
        'artifact.graphs.dense',
      ),
    },
    renderers,
  };
}
