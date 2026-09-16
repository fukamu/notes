import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';

export type FullNetworkTopology = Readonly<{
  structuralKey: string;
  nodeIds: readonly CardId[];
  sources: Uint32Array;
  targets: Uint32Array;
}>;

export type FullNetworkLayoutConfiguration = Readonly<{
  version: 1;
  cellWidth: number;
  cellHeight: number;
  componentGap: number;
  isolatedComponentGap: number;
  shelfAspectRatio: number;
}>;

export const defaultFullNetworkLayoutConfiguration = {
  version: 1,
  cellWidth: 16,
  cellHeight: 12,
  componentGap: 48,
  isolatedComponentGap: 4,
  shelfAspectRatio: 1.25,
} as const satisfies FullNetworkLayoutConfiguration;

export type FullNetworkLayoutComponent = Readonly<{
  structuralKey: string;
  nodeIndexes: Uint32Array;
  edgeCount: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  reused: boolean;
}>;

export type FullNetworkLayout = Readonly<{
  layoutKey: string;
  topologyKey: string;
  nodeCount: number;
  edgeCount: number;
  width: number;
  height: number;
  x: Float32Array;
  y: Float32Array;
  componentIndex: Uint32Array;
  components: readonly FullNetworkLayoutComponent[];
  reusedComponentCount: number;
}>;

export type FullNetworkLayoutSnapshot = Readonly<{
  topology: FullNetworkTopology;
  layout: FullNetworkLayout;
}>;

type GraphIndex = Readonly<{
  degrees: Uint32Array;
  offsets: Uint32Array;
  neighbors: Uint32Array;
  componentNodes: readonly number[][];
  componentEdges: readonly number[][];
}>;

type LocalComponentLayout = Readonly<{
  structuralKey: string;
  nodes: readonly number[];
  edgeIndexes: readonly number[];
  localX: Float32Array;
  localY: Float32Array;
  width: number;
  height: number;
  reused: boolean;
}>;

type PreviousComponentRecord = Readonly<{
  component: FullNetworkLayoutComponent;
  nodeIds: readonly CardId[];
}>;

type PreviousReuseIndex = Readonly<{
  snapshot: FullNetworkLayoutSnapshot;
  nodeIndexes: ReadonlyMap<CardId, number>;
  edgeIdentities: ReadonlySet<number>;
  componentsByKey: ReadonlyMap<string, readonly PreviousComponentRecord[]>;
}>;

const maximumNodes = 10_000;
const maximumEdges = 10_000 * 116;
const hashOffset = 0x811c9dc5;
const hashPrime = 0x01000193;

function typedValue(
  values: Uint32Array | Int32Array | Float32Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function updateHash(hash: number, value: number): number {
  return Math.imul(hash ^ value, hashPrime) >>> 0;
}

function updateStringHash(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = updateHash(next, value.charCodeAt(index));
  }
  return updateHash(next, 0xff);
}

function updateReverseStringHash(hash: number, value: string): number {
  let next = hash;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    next = updateHash(next, value.charCodeAt(index));
  }
  return updateHash(next, 0xff);
}

function topologyFingerprint(
  nodeIds: readonly CardId[],
  sources: Uint32Array,
  targets: Uint32Array,
): string {
  let first = hashOffset;
  let second = hashOffset ^ 0x9e3779b9;
  for (const id of nodeIds) {
    first = updateStringHash(first, id);
    second = updateReverseStringHash(second, id);
  }
  for (let edge = 0; edge < sources.length; edge += 1) {
    const source = typedValue(sources, edge, 'source');
    const target = typedValue(targets, edge, 'target');
    first = updateHash(updateHash(first, source), target);
    second = updateHash(updateHash(second, target), source);
  }
  return `fn-topology-v1:${nodeIds.length}:${sources.length}:${first.toString(16).padStart(8, '0')}:${second.toString(16).padStart(8, '0')}`;
}

export function createFullNetworkTopology(
  input: Pick<ConnectionsInputModel, 'nodes' | 'edges'>,
): FullNetworkTopology {
  if (input.nodes.length > maximumNodes) {
    throw new RangeError(`Full-network topology exceeds ${maximumNodes} nodes`);
  }
  if (input.edges.length > maximumEdges) {
    throw new RangeError(`Full-network topology exceeds ${maximumEdges} edges`);
  }
  const nodeIds = input.nodes.map(({ cardId }) => cardId);
  const nodeIndexes = new Map<CardId, number>();
  for (const [index, id] of nodeIds.entries()) {
    if (nodeIndexes.has(id)) {
      throw new Error(`Full-network topology contains duplicate node ${id}`);
    }
    nodeIndexes.set(id, index);
  }
  const sources = new Uint32Array(input.edges.length);
  const targets = new Uint32Array(input.edges.length);
  for (const [edge, value] of input.edges.entries()) {
    const source = nodeIndexes.get(value.sourceCardId);
    const target = nodeIndexes.get(value.targetCardId);
    if (source === undefined || target === undefined) {
      throw new Error(`Full-network edge ${edge} references an unknown node`);
    }
    sources[edge] = source;
    targets[edge] = target;
  }
  return createFullNetworkTopologyFromNumeric(nodeIds, sources, targets);
}

export function createFullNetworkTopologyFromNumeric(
  inputNodeIds: readonly CardId[],
  inputSources: Uint32Array,
  inputTargets: Uint32Array,
): FullNetworkTopology {
  if (inputNodeIds.length > maximumNodes) {
    throw new RangeError(`Full-network topology exceeds ${maximumNodes} nodes`);
  }
  if (
    inputSources.length !== inputTargets.length ||
    inputSources.length > maximumEdges
  ) {
    throw new RangeError('Full-network topology edge arrays are invalid');
  }
  const nodeIds = [...inputNodeIds];
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('Full-network topology contains duplicate nodes');
  }
  const sources = new Uint32Array(inputSources);
  const targets = new Uint32Array(inputTargets);
  let previousSource = -1;
  let previousTarget = -1;
  for (let edge = 0; edge < sources.length; edge += 1) {
    const source = typedValue(sources, edge, 'source');
    const target = typedValue(targets, edge, 'target');
    if (source >= nodeIds.length || target >= nodeIds.length) {
      throw new RangeError(
        `Full-network edge ${edge} references an unknown node`,
      );
    }
    if (
      source < previousSource ||
      (source === previousSource && target <= previousTarget)
    ) {
      throw new Error(
        `Full-network edge ${edge} is duplicate or not canonically ordered`,
      );
    }
    previousSource = source;
    previousTarget = target;
  }
  return {
    structuralKey: topologyFingerprint(nodeIds, sources, targets),
    nodeIds,
    sources,
    targets,
  };
}

export function sameFullNetworkTopology(
  left: FullNetworkTopology,
  right: FullNetworkTopology,
): boolean {
  if (
    left.structuralKey !== right.structuralKey ||
    left.nodeIds.length !== right.nodeIds.length ||
    left.sources.length !== right.sources.length ||
    left.targets.length !== right.targets.length
  ) {
    return false;
  }
  for (let node = 0; node < left.nodeIds.length; node += 1) {
    if (left.nodeIds[node] !== right.nodeIds[node]) return false;
  }
  for (let edge = 0; edge < left.sources.length; edge += 1) {
    if (
      left.sources[edge] !== right.sources[edge] ||
      left.targets[edge] !== right.targets[edge]
    ) {
      return false;
    }
  }
  return true;
}

export function fullNetworkLayoutKey(
  topology: FullNetworkTopology,
  configuration: FullNetworkLayoutConfiguration,
): string {
  return `${topology.structuralKey}:layout-v${configuration.version}:${configuration.cellWidth}:${configuration.cellHeight}:${configuration.componentGap}:${configuration.isolatedComponentGap}:${configuration.shelfAspectRatio}`;
}

function validateConfiguration(
  configuration: FullNetworkLayoutConfiguration,
): void {
  if (configuration.version !== 1) {
    throw new RangeError('Unsupported full-network layout version');
  }
  positiveFinite(configuration.cellWidth, 'cellWidth');
  positiveFinite(configuration.cellHeight, 'cellHeight');
  positiveFinite(configuration.componentGap, 'componentGap');
  positiveFinite(configuration.isolatedComponentGap, 'isolatedComponentGap');
  positiveFinite(configuration.shelfAspectRatio, 'shelfAspectRatio');
}

function createGraphIndex(topology: FullNetworkTopology): GraphIndex {
  const nodeCount = topology.nodeIds.length;
  const parent = new Int32Array(nodeCount);
  const rank = new Uint8Array(nodeCount);
  const degrees = new Uint32Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) parent[node] = node;

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

  for (let edge = 0; edge < topology.sources.length; edge += 1) {
    const source = typedValue(topology.sources, edge, 'source');
    const target = typedValue(topology.targets, edge, 'target');
    if (source >= nodeCount || target >= nodeCount) {
      throw new RangeError(`Full-network edge ${edge} is out of range`);
    }
    degrees[source] = typedValue(degrees, source, 'source degree') + 1;
    degrees[target] = typedValue(degrees, target, 'target degree') + 1;
    union(source, target);
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) {
    offsets[node + 1] =
      typedValue(offsets, node, 'offset') + typedValue(degrees, node, 'degree');
  }
  const neighbors = new Uint32Array(
    typedValue(offsets, nodeCount, 'final offset'),
  );
  const cursors = new Uint32Array(offsets);
  for (let edge = 0; edge < topology.sources.length; edge += 1) {
    const source = typedValue(topology.sources, edge, 'source');
    const target = typedValue(topology.targets, edge, 'target');
    const sourceCursor = typedValue(cursors, source, 'source cursor');
    const targetCursor = typedValue(cursors, target, 'target cursor');
    neighbors[sourceCursor] = target;
    neighbors[targetCursor] = source;
    cursors[source] = sourceCursor + 1;
    cursors[target] = targetCursor + 1;
  }

  const nodesByRoot = new Map<number, number[]>();
  for (let node = 0; node < nodeCount; node += 1) {
    const root = find(node);
    const nodes = nodesByRoot.get(root) ?? [];
    nodes.push(node);
    nodesByRoot.set(root, nodes);
  }
  const edgesByRoot = new Map<number, number[]>();
  for (let edge = 0; edge < topology.sources.length; edge += 1) {
    const source = typedValue(topology.sources, edge, 'source');
    const root = find(source);
    const edges = edgesByRoot.get(root) ?? [];
    edges.push(edge);
    edgesByRoot.set(root, edges);
  }
  const roots = [...nodesByRoot.keys()].sort((left, right) => {
    const leftNodes = nodesByRoot.get(left);
    const rightNodes = nodesByRoot.get(right);
    if (!leftNodes || !rightNodes)
      throw new Error('Component root disappeared');
    return (
      rightNodes.length - leftNodes.length ||
      (topology.nodeIds[leftNodes[0] ?? 0] ?? '').localeCompare(
        topology.nodeIds[rightNodes[0] ?? 0] ?? '',
      )
    );
  });
  return {
    degrees,
    offsets,
    neighbors,
    componentNodes: roots.map((root) => nodesByRoot.get(root) ?? []),
    componentEdges: roots.map((root) => edgesByRoot.get(root) ?? []),
  };
}

function componentFingerprint(
  topology: FullNetworkTopology,
  nodes: readonly number[],
  edgeIndexes: readonly number[],
): string {
  let hash = hashOffset;
  const localIndexes = new Map<number, number>();
  for (const [localIndex, node] of nodes.entries()) {
    const id = topology.nodeIds[node];
    if (id === undefined) throw new Error(`Component omitted node ${node}`);
    localIndexes.set(node, localIndex);
    hash = updateStringHash(hash, id);
  }
  for (const edge of edgeIndexes) {
    const source = localIndexes.get(
      typedValue(topology.sources, edge, 'source'),
    );
    const target = localIndexes.get(
      typedValue(topology.targets, edge, 'target'),
    );
    if (source === undefined || target === undefined) {
      throw new Error(`Component omitted edge ${edge}`);
    }
    hash = updateHash(hash, source);
    hash = updateHash(hash, target);
  }
  return `fn-component-v1:${nodes.length}:${edgeIndexes.length}:${hash.toString(16).padStart(8, '0')}`;
}

function edgeIdentity(source: number, target: number): number {
  return source * maximumNodes + target;
}

function createPreviousReuseIndex(
  snapshot: FullNetworkLayoutSnapshot | undefined,
): PreviousReuseIndex | undefined {
  if (!snapshot) return undefined;
  const nodeIndexes = new Map(
    snapshot.topology.nodeIds.map((id, index) => [id, index]),
  );
  const edgeIdentities = new Set<number>();
  for (let edge = 0; edge < snapshot.topology.sources.length; edge += 1) {
    edgeIdentities.add(
      edgeIdentity(
        typedValue(snapshot.topology.sources, edge, 'previous source'),
        typedValue(snapshot.topology.targets, edge, 'previous target'),
      ),
    );
  }
  const componentsByKey = new Map<string, PreviousComponentRecord[]>();
  for (const component of snapshot.layout.components) {
    const nodeIds: CardId[] = [];
    for (const nodeIndex of component.nodeIndexes) {
      const id = snapshot.topology.nodeIds[nodeIndex];
      if (id === undefined) {
        throw new Error(
          `Previous component references unknown node ${nodeIndex}`,
        );
      }
      nodeIds.push(id);
    }
    nodeIds.sort();
    const records = componentsByKey.get(component.structuralKey) ?? [];
    records.push({ component, nodeIds });
    componentsByKey.set(component.structuralKey, records);
  }
  return { snapshot, nodeIndexes, edgeIdentities, componentsByKey };
}

function sameComponent(
  nextTopology: FullNetworkTopology,
  nextNodes: readonly number[],
  nextEdges: readonly number[],
  previous: PreviousReuseIndex,
  record: PreviousComponentRecord,
): boolean {
  if (
    nextNodes.length !== record.nodeIds.length ||
    nextEdges.length !== record.component.edgeCount
  ) {
    return false;
  }
  const nextNodeIds: CardId[] = [];
  for (const nextNode of nextNodes) {
    const id = nextTopology.nodeIds[nextNode];
    if (id === undefined || !previous.nodeIndexes.has(id)) return false;
    nextNodeIds.push(id);
  }
  nextNodeIds.sort();
  for (const [index, nextNodeId] of nextNodeIds.entries()) {
    if (nextNodeId !== record.nodeIds[index]) return false;
  }
  for (const edge of nextEdges) {
    const source = typedValue(nextTopology.sources, edge, 'source');
    const target = typedValue(nextTopology.targets, edge, 'target');
    const sourceId = nextTopology.nodeIds[source];
    const targetId = nextTopology.nodeIds[target];
    const previousSource =
      sourceId === undefined ? undefined : previous.nodeIndexes.get(sourceId);
    const previousTarget =
      targetId === undefined ? undefined : previous.nodeIndexes.get(targetId);
    if (
      previousSource === undefined ||
      previousTarget === undefined ||
      !previous.edgeIdentities.has(edgeIdentity(previousSource, previousTarget))
    ) {
      return false;
    }
  }
  return true;
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
  if (start === undefined) throw new Error('Component omitted its start');
  const inComponent = new Uint8Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  for (const node of nodes) inComponent[node] = 1;
  const queue: number[] = [start];
  visited[start] = 1;
  for (let position = 0; position < queue.length; position += 1) {
    const node = queue[position];
    if (node === undefined) throw new Error(`BFS omitted queue ${position}`);
    const first = typedValue(index.offsets, node, 'first offset');
    const last = typedValue(index.offsets, node + 1, 'last offset');
    const candidates: number[] = [];
    for (let cursor = first; cursor < last; cursor += 1) {
      const neighbor = typedValue(index.neighbors, cursor, 'neighbor');
      if (inComponent[neighbor] === 1 && visited[neighbor] !== 1) {
        candidates.push(neighbor);
      }
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

function reusableLocalLayout(
  topology: FullNetworkTopology,
  nodes: readonly number[],
  edgeIndexes: readonly number[],
  structuralKey: string,
  previous: PreviousReuseIndex | undefined,
): LocalComponentLayout | null {
  if (!previous) return null;
  const record = previous.componentsByKey
    .get(structuralKey)
    ?.find((candidate) =>
      sameComponent(topology, nodes, edgeIndexes, previous, candidate),
    );
  if (!record) return null;
  const candidate = record.component;
  const localX = new Float32Array(nodes.length);
  const localY = new Float32Array(nodes.length);
  for (const [position, node] of nodes.entries()) {
    const id = topology.nodeIds[node];
    const previousNode =
      id === undefined ? undefined : previous.nodeIndexes.get(id);
    if (previousNode === undefined) return null;
    localX[position] =
      typedValue(previous.snapshot.layout.x, previousNode, 'previous x') -
      candidate.originX;
    localY[position] =
      typedValue(previous.snapshot.layout.y, previousNode, 'previous y') -
      candidate.originY;
  }
  return {
    structuralKey,
    nodes,
    edgeIndexes,
    localX,
    localY,
    width: candidate.width,
    height: candidate.height,
    reused: true,
  };
}

function createLocalLayout(
  topology: FullNetworkTopology,
  nodes: readonly number[],
  edgeIndexes: readonly number[],
  index: GraphIndex,
  configuration: FullNetworkLayoutConfiguration,
  previous: PreviousReuseIndex | undefined,
): LocalComponentLayout {
  const structuralKey = componentFingerprint(topology, nodes, edgeIndexes);
  const reused = reusableLocalLayout(
    topology,
    nodes,
    edgeIndexes,
    structuralKey,
    previous,
  );
  if (reused) return reused;
  const order = breadthFirstOrder(nodes, index, topology.nodeIds.length);
  const columns = Math.max(
    1,
    Math.ceil(
      Math.sqrt(
        (order.length * configuration.cellHeight) / configuration.cellWidth,
      ),
    ),
  );
  const rows = Math.max(1, Math.ceil(order.length / columns));
  const positionByNode = new Map(
    nodes.map((node, position) => [node, position]),
  );
  const localX = new Float32Array(nodes.length);
  const localY = new Float32Array(nodes.length);
  for (const [position, node] of order.entries()) {
    const target = positionByNode.get(node);
    if (target === undefined) throw new Error(`Component omitted node ${node}`);
    const row = Math.floor(position / columns);
    const offset = position % columns;
    const column = row % 2 === 0 ? offset : columns - 1 - offset;
    localX[target] = column * configuration.cellWidth;
    localY[target] = row * configuration.cellHeight;
  }
  return {
    structuralKey,
    nodes,
    edgeIndexes,
    localX,
    localY,
    width: columns * configuration.cellWidth,
    height: rows * configuration.cellHeight,
    reused: false,
  };
}

export function layoutFullNetworkTopology(
  topology: FullNetworkTopology,
  configuration: FullNetworkLayoutConfiguration = defaultFullNetworkLayoutConfiguration,
  previous?: FullNetworkLayoutSnapshot,
): FullNetworkLayout {
  validateConfiguration(configuration);
  const index = createGraphIndex(topology);
  const previousReuseIndex = createPreviousReuseIndex(previous);
  const localLayouts = index.componentNodes.map((nodes, component) =>
    createLocalLayout(
      topology,
      nodes,
      index.componentEdges[component] ?? [],
      index,
      configuration,
      previousReuseIndex,
    ),
  );
  const totalArea = localLayouts.reduce((sum, component) => {
    const gap =
      component.nodes.length === 1
        ? configuration.isolatedComponentGap
        : configuration.componentGap;
    return sum + (component.width + gap) * (component.height + gap);
  }, 0);
  const targetShelfWidth = Math.max(
    configuration.cellWidth,
    Math.sqrt(totalArea) * configuration.shelfAspectRatio,
  );
  const x = new Float32Array(topology.nodeIds.length);
  const y = new Float32Array(topology.nodeIds.length);
  const componentIndex = new Uint32Array(topology.nodeIds.length);
  const components: FullNetworkLayoutComponent[] = [];
  let originX = 0;
  let originY = 0;
  let shelfHeight = 0;
  let maximumX = 0;
  for (const [outputIndex, component] of localLayouts.entries()) {
    const gap =
      component.nodes.length === 1
        ? configuration.isolatedComponentGap
        : configuration.componentGap;
    if (originX > 0 && originX + component.width > targetShelfWidth) {
      originX = 0;
      originY += shelfHeight;
      shelfHeight = 0;
    }
    for (const [position, node] of component.nodes.entries()) {
      x[node] = originX + typedValue(component.localX, position, 'local x');
      y[node] = originY + typedValue(component.localY, position, 'local y');
      componentIndex[node] = outputIndex;
    }
    components.push({
      structuralKey: component.structuralKey,
      nodeIndexes: Uint32Array.from(component.nodes),
      edgeCount: component.edgeIndexes.length,
      originX,
      originY,
      width: component.width,
      height: component.height,
      reused: component.reused,
    });
    maximumX = Math.max(maximumX, originX + component.width);
    originX += component.width + gap;
    shelfHeight = Math.max(shelfHeight, component.height + gap);
  }
  const height = localLayouts.length === 0 ? 0 : originY + shelfHeight;
  const layout: FullNetworkLayout = {
    layoutKey: fullNetworkLayoutKey(topology, configuration),
    topologyKey: topology.structuralKey,
    nodeCount: topology.nodeIds.length,
    edgeCount: topology.sources.length,
    width: maximumX,
    height,
    x,
    y,
    componentIndex,
    components,
    reusedComponentCount: components.filter(({ reused }) => reused).length,
  };
  validateFullNetworkLayout(topology, layout);
  return layout;
}

export function validateFullNetworkLayout(
  topology: FullNetworkTopology,
  layout: FullNetworkLayout,
): void {
  if (
    layout.topologyKey !== topology.structuralKey ||
    layout.nodeCount !== topology.nodeIds.length ||
    layout.edgeCount !== topology.sources.length ||
    layout.x.length !== topology.nodeIds.length ||
    layout.y.length !== topology.nodeIds.length ||
    layout.componentIndex.length !== topology.nodeIds.length
  ) {
    throw new Error('Full-network layout identity does not match its topology');
  }
  if (
    !Number.isFinite(layout.width) ||
    layout.width < 0 ||
    !Number.isFinite(layout.height) ||
    layout.height < 0
  ) {
    throw new Error('Full-network layout has invalid bounds');
  }
  const positions = new Set<string>();
  for (let node = 0; node < topology.nodeIds.length; node += 1) {
    const x = typedValue(layout.x, node, 'layout x');
    const y = typedValue(layout.y, node, 'layout y');
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Full-network layout node ${node} is not finite`);
    }
    if (
      typedValue(layout.componentIndex, node, 'component') >=
      layout.components.length
    ) {
      throw new Error(`Full-network layout node ${node} has no component`);
    }
    const position = `${x}:${y}`;
    if (positions.has(position)) {
      throw new Error(`Full-network layout overlaps node ${node}`);
    }
    positions.add(position);
  }
  const seenNodes = new Uint8Array(topology.nodeIds.length);
  let componentNodes = 0;
  let reusedComponentCount = 0;
  for (const [index, component] of layout.components.entries()) {
    if (
      component.nodeIndexes.length === 0 ||
      !Number.isSafeInteger(component.edgeCount) ||
      component.edgeCount < 0 ||
      !Number.isFinite(component.originX) ||
      component.originX < 0 ||
      !Number.isFinite(component.originY) ||
      component.originY < 0 ||
      !Number.isFinite(component.width) ||
      component.width <= 0 ||
      !Number.isFinite(component.height) ||
      component.height <= 0
    ) {
      throw new Error(`Full-network layout component ${index} is invalid`);
    }
    if (component.reused) reusedComponentCount += 1;
    for (const node of component.nodeIndexes) {
      if (node >= topology.nodeIds.length || seenNodes[node] === 1) {
        throw new Error(
          `Full-network layout component ${index} has an invalid node identity`,
        );
      }
      if (typedValue(layout.componentIndex, node, 'component') !== index) {
        throw new Error(
          `Full-network layout component ${index} disagrees with its node index`,
        );
      }
      seenNodes[node] = 1;
      componentNodes += 1;
    }
  }
  if (
    componentNodes !== topology.nodeIds.length ||
    seenNodes.some((seen) => seen !== 1)
  ) {
    throw new Error('Full-network layout components omitted nodes');
  }
  if (layout.reusedComponentCount !== reusedComponentCount) {
    throw new Error('Full-network layout reused-component count is invalid');
  }
}
