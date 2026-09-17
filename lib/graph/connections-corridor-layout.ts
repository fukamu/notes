import type { CardId } from '@/lib/domain/id';
import type {
  ConnectionsLayout,
  ConnectionsLayoutEdge,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
  ConnectionsLayoutNode,
  ConnectionsLayoutPort,
  ConnectionsPortSide,
  LayoutPoint,
} from '@/lib/graph/elk-layout';
import { invariant } from '@/lib/shared/invariant';

export type ConnectionsCorridorOptions = Readonly<{
  laneSpacing: number;
}>;

type IndexedNode = Readonly<{
  id: CardId;
  originalIndex: number;
}>;

type IndexedEdge = Readonly<{
  sourceCardId: CardId;
  targetCardId: CardId;
  originalIndex: number;
  sourceIndex: number;
  targetIndex: number;
}>;

type Slot = Readonly<{ row: number; column: number }>;

type RouteInterval = Readonly<{
  start: number;
  end: number;
  edgeIndex: number;
  part: number;
}>;

type PortRole = 'source' | 'target';
type VerticalPortSide = Extract<ConnectionsPortSide, 'NORTH' | 'SOUTH'>;
const verticalPortSides: readonly VerticalPortSide[] = ['NORTH', 'SOUTH'];

type PortReference = Readonly<{
  edgeIndex: number;
  role: PortRole;
  otherNodeIndex: number;
  id: string;
  side: VerticalPortSide;
}>;

type RouteBase = Readonly<{
  edge: IndexedEdge;
  sourceNodeIndex: number;
  targetNodeIndex: number;
  sourcePort: PortReference;
  targetPort: PortReference;
  sourceCorridor: number;
  targetCorridor: number;
}>;

type RoutePlan =
  | (RouteBase &
      Readonly<{
        kind: 'direct';
        horizontal: RouteInterval;
      }>)
  | (RouteBase &
      Readonly<{
        kind: 'corridor';
        sourceHorizontal: RouteInterval;
        targetHorizontal: RouteInterval;
        vertical: RouteInterval;
        channel: number;
      }>);

type ActiveLane = Readonly<{ end: number; lane: number }>;

type Component = Readonly<{
  nodeIndices: readonly number[];
  edgeIndices: readonly number[];
  stableId: CardId;
}>;

type LaidOutComponent = Readonly<{
  component: Component;
  layout: ConnectionsLayout;
}>;

class MinHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.values.length;
  }

  peek(): T | undefined {
    return this.values[0];
  }

  push(value: T): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this.values[parentIndex];
      invariant(parent, 'Connections lane heap omitted its parent');
      if (this.compare(parent, value) <= 0) break;
      this.values[index] = parent;
      index = parentIndex;
    }
    this.values[index] = value;
  }

  pop(): T | undefined {
    const first = this.values[0];
    if (first === undefined) return undefined;
    const last = this.values.pop();
    if (this.values.length === 0) return first;
    invariant(last, 'Connections lane heap omitted its final value');
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let childIndex = index * 2 + 1;
      const left = this.values[childIndex];
      invariant(left, 'Connections lane heap omitted its left child');
      const right = this.values[childIndex + 1];
      if (right !== undefined && this.compare(right, left) < 0) {
        childIndex += 1;
      }
      const child = this.values[childIndex];
      invariant(child, 'Connections lane heap omitted its selected child');
      if (this.compare(last, child) <= 0) break;
      this.values[index] = child;
      index = childIndex;
    }
    this.values[index] = last;
    return first;
  }
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Connections corridor ${label} must be positive`);
  }
  return value;
}

function stableTextCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateMetrics(metrics: ConnectionsLayoutMetrics): void {
  positive(metrics.nodeWidth, 'nodeWidth');
  positive(metrics.nodeHeight, 'nodeHeight');
  positive(metrics.portSize, 'portSize');
  positive(metrics.componentSpacing, 'componentSpacing');
  positive(metrics.nodeSpacing, 'nodeSpacing');
  positive(metrics.edgeNodeSpacing, 'edgeNodeSpacing');
  positive(metrics.layerSpacing, 'layerSpacing');
  positive(metrics.edgeLayerSpacing, 'edgeLayerSpacing');
  positive(metrics.padding.top, 'padding.top');
  positive(metrics.padding.right, 'padding.right');
  positive(metrics.padding.bottom, 'padding.bottom');
  positive(metrics.padding.left, 'padding.left');
}

function indexedGraph(graph: ConnectionsLayoutGraph): Readonly<{
  nodes: readonly IndexedNode[];
  edges: readonly IndexedEdge[];
  indexById: ReadonlyMap<CardId, number>;
}> {
  const nodes = graph.nodes.map((node, originalIndex) => ({
    id: node.id,
    originalIndex,
  }));
  const indexById = new Map<CardId, number>();
  for (const node of nodes) {
    if (indexById.has(node.id)) {
      throw new Error(`Connections corridor duplicate node ${node.id}`);
    }
    indexById.set(node.id, node.originalIndex);
  }
  const edges = graph.edges.map((edge, originalIndex): IndexedEdge => {
    const sourceIndex = indexById.get(edge.sourceCardId);
    const targetIndex = indexById.get(edge.targetCardId);
    if (sourceIndex === undefined) {
      throw new Error(
        `Connections corridor missing source ${edge.sourceCardId}`,
      );
    }
    if (targetIndex === undefined) {
      throw new Error(
        `Connections corridor missing target ${edge.targetCardId}`,
      );
    }
    return {
      sourceCardId: edge.sourceCardId,
      targetCardId: edge.targetCardId,
      originalIndex,
      sourceIndex,
      targetIndex,
    };
  });
  return { nodes, edges, indexById };
}

function connectedComponents(
  nodes: readonly IndexedNode[],
  edges: readonly IndexedEdge[],
): readonly Component[] {
  const adjacency = nodes.map((): number[] => []);
  for (const edge of edges) {
    if (edge.sourceIndex === edge.targetIndex) continue;
    adjacency[edge.sourceIndex]?.push(edge.targetIndex);
    adjacency[edge.targetIndex]?.push(edge.sourceIndex);
  }
  const membership = new Int32Array(nodes.length);
  membership.fill(-1);
  const mutableComponents: {
    nodeIndices: number[];
    edgeIndices: number[];
    stableId: CardId;
  }[] = [];
  for (const root of nodes) {
    if (membership[root.originalIndex] !== -1) continue;
    const componentIndex = mutableComponents.length;
    const nodeIndices = [root.originalIndex];
    membership[root.originalIndex] = componentIndex;
    let stableId = root.id;
    for (let head = 0; head < nodeIndices.length; head += 1) {
      const nodeIndex = nodeIndices[head];
      invariant(nodeIndex, 'Connections component traversal omitted a node');
      const node = nodes[nodeIndex];
      invariant(node, `Connections component omitted node ${nodeIndex}`);
      if (stableTextCompare(node.id, stableId) < 0) stableId = node.id;
      for (const neighbor of adjacency[nodeIndex] ?? []) {
        if (membership[neighbor] !== -1) continue;
        membership[neighbor] = componentIndex;
        nodeIndices.push(neighbor);
      }
    }
    mutableComponents.push({ nodeIndices, edgeIndices: [], stableId });
  }
  for (const edge of edges) {
    const componentIndex = membership[edge.sourceIndex];
    if (componentIndex === undefined || componentIndex < 0) {
      throw new Error(
        `Connections corridor omitted component for ${edge.sourceCardId}`,
      );
    }
    const component = mutableComponents[componentIndex];
    invariant(
      component,
      `Connections corridor omitted component ${componentIndex}`,
    );
    component.edgeIndices.push(edge.originalIndex);
  }
  return mutableComponents;
}

function orderComponentNodes(
  nodes: readonly IndexedNode[],
  edges: readonly IndexedEdge[],
): readonly number[] {
  const localIndexByOriginal = new Map<number, number>(
    nodes.map((node, localIndex) => [node.originalIndex, localIndex]),
  );
  const adjacency = nodes.map((): number[] => []);
  for (const edge of edges) {
    const source = localIndexByOriginal.get(edge.sourceIndex);
    const target = localIndexByOriginal.get(edge.targetIndex);
    invariant(
      source,
      `Connections ordering omitted source ${edge.sourceIndex}`,
    );
    invariant(
      target,
      `Connections ordering omitted target ${edge.targetIndex}`,
    );
    if (source === target) continue;
    adjacency[source]?.push(target);
    adjacency[target]?.push(source);
  }
  const compare = (left: number, right: number) => {
    const leftNode = nodes[left];
    const rightNode = nodes[right];
    invariant(leftNode, `Connections ordering omitted node ${left}`);
    invariant(rightNode, `Connections ordering omitted node ${right}`);
    return (
      (adjacency[left]?.length ?? 0) - (adjacency[right]?.length ?? 0) ||
      stableTextCompare(leftNode.id, rightNode.id)
    );
  };
  const roots = nodes.map((_, index) => index).sort(compare);
  const sortedAdjacency = adjacency.map((neighbors) =>
    [...neighbors].sort(compare),
  );
  const seen = new Uint8Array(nodes.length);
  const order: number[] = [];
  for (const root of roots) {
    if (seen[root]) continue;
    const queue = [root];
    seen[root] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      invariant(current, 'Connections ordering traversal omitted a node');
      for (const next of sortedAdjacency[current] ?? []) {
        if (seen[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const nodeIndex = queue[index];
      invariant(nodeIndex, 'Connections ordering reversal omitted a node');
      order.push(nodeIndex);
    }
  }
  return order;
}

function allocateLanes(
  corridors: readonly (readonly RouteInterval[])[],
): Readonly<{
  counts: readonly number[];
  lanes: ReadonlyMap<RouteInterval, number>;
}> {
  const counts: number[] = [];
  const lanes = new Map<RouteInterval, number>();
  for (const segments of corridors) {
    const ordered = [...segments].sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.edgeIndex - right.edgeIndex ||
        left.part - right.part,
    );
    const active = new MinHeap<ActiveLane>(
      (left, right) => left.end - right.end || left.lane - right.lane,
    );
    const available = new MinHeap<number>((left, right) => left - right);
    let count = 0;
    for (const segment of ordered) {
      while ((active.peek()?.end ?? Number.POSITIVE_INFINITY) < segment.start) {
        const released = active.pop();
        invariant(released, 'Connections lane allocator omitted active lane');
        available.push(released.lane);
      }
      const reusable = available.pop();
      const lane = reusable ?? count++;
      lanes.set(segment, lane);
      active.push({ end: segment.end, lane });
    }
    counts.push(count);
  }
  return { counts, lanes };
}

function compactPolyline(points: readonly LayoutPoint[]): LayoutPoint[] {
  const compacted: LayoutPoint[] = [];
  for (const point of points) {
    const previous = compacted.at(-1);
    if (previous && point.x === previous.x && point.y === previous.y) continue;
    if (compacted.length > 1 && previous) {
      const before = compacted.at(-2);
      invariant(before, 'Connections polyline omitted its preceding point');
      const sameX = before.x === previous.x && previous.x === point.x;
      const sameY = before.y === previous.y && previous.y === point.y;
      const forward =
        (previous.x - before.x) * (point.x - previous.x) >= 0 &&
        (previous.y - before.y) * (point.y - previous.y) >= 0;
      if ((sameX || sameY) && forward) compacted.pop();
    }
    compacted.push({ x: point.x, y: point.y });
  }
  return compacted;
}

function layoutGridComponent(
  nodes: readonly IndexedNode[],
  edges: readonly IndexedEdge[],
  metrics: ConnectionsLayoutMetrics,
  options: ConnectionsCorridorOptions,
): ConnectionsLayout {
  const nodeWidth = metrics.nodeWidth;
  const nodeHeight = metrics.nodeHeight;
  const portSize = metrics.portSize;
  const clearance = Math.max(16, metrics.edgeNodeSpacing);
  const laneSpacing = options.laneSpacing;
  const padding = metrics.padding;
  const order = orderComponentNodes(nodes, edges);
  const columns = Math.max(
    1,
    Math.min(
      order.length,
      Math.ceil(
        Math.sqrt(
          order.length *
            (16 / 9) *
            ((nodeHeight + metrics.nodeSpacing) /
              (nodeWidth + metrics.layerSpacing)),
        ),
      ),
    ),
  );
  const rows = Math.ceil(order.length / columns);
  const slots: (Slot | undefined)[] = Array.from(
    { length: nodes.length },
    (): Slot | undefined => undefined,
  );
  for (let index = 0; index < order.length; index += 1) {
    const nodeIndex = order[index];
    invariant(nodeIndex, `Connections grid omitted order ${index}`);
    const row = Math.floor(index / columns);
    const position = index % columns;
    slots[nodeIndex] = {
      row,
      column: row % 2 === 0 ? position : columns - 1 - position,
    };
  }
  const horizontal: RouteInterval[][] = Array.from(
    { length: rows + 1 },
    () => [],
  );
  const vertical: RouteInterval[][] = Array.from(
    { length: columns + 1 },
    () => [],
  );
  const portGroups: Record<VerticalPortSide, PortReference[]>[] = nodes.map(
    () => ({ NORTH: [], SOUTH: [] }),
  );
  const localIndexByOriginal = new Map<number, number>(
    nodes.map((node, localIndex) => [node.originalIndex, localIndex]),
  );
  const routes: RoutePlan[] = [];

  for (const edge of edges) {
    const sourceNodeIndex = localIndexByOriginal.get(edge.sourceIndex);
    const targetNodeIndex = localIndexByOriginal.get(edge.targetIndex);
    invariant(
      sourceNodeIndex,
      `Connections route omitted source ${edge.sourceIndex}`,
    );
    invariant(
      targetNodeIndex,
      `Connections route omitted target ${edge.targetIndex}`,
    );
    const source = slots[sourceNodeIndex];
    const target = slots[targetNodeIndex];
    invariant(
      source,
      `Connections route omitted source slot ${sourceNodeIndex}`,
    );
    invariant(
      target,
      `Connections route omitted target slot ${targetNodeIndex}`,
    );
    const sourceSide: VerticalPortSide =
      target.row < source.row ? 'NORTH' : 'SOUTH';
    const targetSide: VerticalPortSide =
      source.row < target.row ? 'NORTH' : 'SOUTH';
    const sourceCorridor = source.row + (sourceSide === 'SOUTH' ? 1 : 0);
    const targetCorridor = target.row + (targetSide === 'SOUTH' ? 1 : 0);
    const sourcePort: PortReference = {
      edgeIndex: edge.originalIndex,
      role: 'source',
      otherNodeIndex: targetNodeIndex,
      id: `port-${edge.originalIndex}-source`,
      side: sourceSide,
    };
    const targetPort: PortReference = {
      edgeIndex: edge.originalIndex,
      role: 'target',
      otherNodeIndex: sourceNodeIndex,
      id: `port-${edge.originalIndex}-target`,
      side: targetSide,
    };
    portGroups[sourceNodeIndex]?.[sourceSide].push(sourcePort);
    portGroups[targetNodeIndex]?.[targetSide].push(targetPort);
    const base: RouteBase = {
      edge,
      sourceNodeIndex,
      targetNodeIndex,
      sourcePort,
      targetPort,
      sourceCorridor,
      targetCorridor,
    };
    if (sourceCorridor === targetCorridor) {
      const interval: RouteInterval = {
        start: Math.min(source.column, target.column) - 1,
        end: Math.max(source.column, target.column) + 1,
        edgeIndex: edge.originalIndex,
        part: 0,
      };
      horizontal[sourceCorridor]?.push(interval);
      routes.push({ ...base, kind: 'direct', horizontal: interval });
      continue;
    }
    const candidates = [
      ...new Set([
        source.column,
        target.column + 1,
        Math.floor((source.column + target.column + 1) / 2),
      ]),
    ];
    let channel: number | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const cost =
        Math.abs(source.column + 0.5 - candidate) +
        Math.abs(target.column + 0.5 - candidate) +
        (vertical[candidate]?.length ?? 0) * 0.05;
      if (
        cost < bestCost ||
        (cost === bestCost && (channel === undefined || candidate < channel))
      ) {
        channel = candidate;
        bestCost = cost;
      }
    }
    invariant(
      channel,
      `Connections route omitted channel for ${edge.originalIndex}`,
    );
    const sourceHorizontal: RouteInterval = {
      start: Math.min(source.column, channel) - 1,
      end: Math.max(source.column + 1, channel) + 1,
      edgeIndex: edge.originalIndex,
      part: 0,
    };
    const targetHorizontal: RouteInterval = {
      start: Math.min(target.column, channel) - 1,
      end: Math.max(target.column + 1, channel) + 1,
      edgeIndex: edge.originalIndex,
      part: 1,
    };
    const verticalInterval: RouteInterval = {
      start: Math.min(sourceCorridor, targetCorridor) - 1,
      end: Math.max(sourceCorridor, targetCorridor) + 1,
      edgeIndex: edge.originalIndex,
      part: 2,
    };
    horizontal[sourceCorridor]?.push(sourceHorizontal);
    horizontal[targetCorridor]?.push(targetHorizontal);
    vertical[channel]?.push(verticalInterval);
    routes.push({
      ...base,
      kind: 'corridor',
      sourceHorizontal,
      targetHorizontal,
      vertical: verticalInterval,
      channel,
    });
  }

  const horizontalAllocation = allocateLanes(horizontal);
  const verticalAllocation = allocateLanes(vertical);
  const horizontalStarts: number[] = [];
  const horizontalWidths: number[] = [];
  const nodeYs: number[] = [];
  let cursor = padding.top;
  for (let row = 0; row <= rows; row += 1) {
    const count = horizontalAllocation.counts[row] ?? 0;
    const gap = Math.max(
      metrics.nodeSpacing,
      clearance * 2 + count * laneSpacing,
    );
    horizontalStarts.push(cursor);
    horizontalWidths.push(gap);
    cursor += gap;
    if (row < rows) {
      nodeYs.push(cursor);
      cursor += nodeHeight;
    }
  }
  const height = cursor + padding.bottom;
  const verticalStarts: number[] = [];
  const verticalWidths: number[] = [];
  const nodeXs: number[] = [];
  cursor = padding.left;
  for (let column = 0; column <= columns; column += 1) {
    const count = verticalAllocation.counts[column] ?? 0;
    const gap = Math.max(
      metrics.layerSpacing,
      clearance * 2 + count * laneSpacing,
    );
    verticalStarts.push(cursor);
    verticalWidths.push(gap);
    cursor += gap;
    if (column < columns) {
      nodeXs.push(cursor);
      cursor += nodeWidth;
    }
  }
  const width = cursor + padding.right;

  const horizontalY = (corridor: number, lane: number): number => {
    const start = horizontalStarts[corridor];
    const widthValue = horizontalWidths[corridor];
    const count = horizontalAllocation.counts[corridor];
    invariant(start, `Connections route omitted horizontal start ${corridor}`);
    invariant(
      widthValue,
      `Connections route omitted horizontal width ${corridor}`,
    );
    invariant(count, `Connections route omitted horizontal count ${corridor}`);
    return start + widthValue / 2 + (lane - (count - 1) / 2) * laneSpacing;
  };
  const verticalX = (corridor: number, lane: number): number => {
    const start = verticalStarts[corridor];
    const widthValue = verticalWidths[corridor];
    const count = verticalAllocation.counts[corridor];
    invariant(start, `Connections route omitted vertical start ${corridor}`);
    invariant(
      widthValue,
      `Connections route omitted vertical width ${corridor}`,
    );
    invariant(count, `Connections route omitted vertical count ${corridor}`);
    return start + widthValue / 2 + (lane - (count - 1) / 2) * laneSpacing;
  };

  const portsByNode = nodes.map((): ConnectionsLayoutPort[] => []);
  const portPoints = new Map<PortReference, LayoutPoint>();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const slot = slots[nodeIndex];
    invariant(slot, `Connections port layout omitted slot ${nodeIndex}`);
    const nodeX = nodeXs[slot.column];
    const nodeY = nodeYs[slot.row];
    invariant(nodeX, `Connections port layout omitted x ${slot.column}`);
    invariant(nodeY, `Connections port layout omitted y ${slot.row}`);
    const groups = portGroups[nodeIndex];
    invariant(groups, `Connections port layout omitted groups ${nodeIndex}`);
    for (const side of verticalPortSides) {
      const group: PortReference[] = [...groups[side]].sort((left, right) => {
        const leftSlot = slots[left.otherNodeIndex];
        const rightSlot = slots[right.otherNodeIndex];
        invariant(
          leftSlot,
          `Connections port ordering omitted ${left.otherNodeIndex}`,
        );
        invariant(
          rightSlot,
          `Connections port ordering omitted ${right.otherNodeIndex}`,
        );
        return (
          leftSlot.column - rightSlot.column ||
          leftSlot.row - rightSlot.row ||
          left.edgeIndex - right.edgeIndex ||
          stableTextCompare(left.role, right.role)
        );
      });
      const margin = Math.min(16, nodeWidth / 4);
      for (let ordinal = 0; ordinal < group.length; ordinal += 1) {
        const reference: PortReference | undefined = group[ordinal];
        invariant(reference, `Connections port group omitted ${ordinal}`);
        const centerX =
          nodeX +
          margin +
          ((nodeWidth - margin * 2) * (ordinal + 1)) / (group.length + 1);
        const portY = side === 'NORTH' ? nodeY - portSize : nodeY + nodeHeight;
        const port: ConnectionsLayoutPort = {
          id: reference.id,
          x: centerX - portSize / 2,
          y: portY,
          width: portSize,
          height: portSize,
          side,
        };
        portsByNode[nodeIndex]?.push(port);
        portPoints.set(reference, {
          x: centerX,
          y: side === 'NORTH' ? portY : portY + portSize,
        });
      }
    }
  }

  const layoutNodes = nodes.map((node, nodeIndex): ConnectionsLayoutNode => {
    const slot = slots[nodeIndex];
    invariant(slot, `Connections node layout omitted slot ${nodeIndex}`);
    const x = nodeXs[slot.column];
    const y = nodeYs[slot.row];
    invariant(x, `Connections node layout omitted x ${slot.column}`);
    invariant(y, `Connections node layout omitted y ${slot.row}`);
    return {
      id: node.id,
      x,
      y,
      width: nodeWidth,
      height: nodeHeight,
      ports: portsByNode[nodeIndex] ?? [],
    };
  });

  const layoutEdges = routes.map((route): ConnectionsLayoutEdge => {
    const start = portPoints.get(route.sourcePort);
    const end = portPoints.get(route.targetPort);
    invariant(
      start,
      `Connections route omitted source port ${route.sourcePort.id}`,
    );
    invariant(
      end,
      `Connections route omitted target port ${route.targetPort.id}`,
    );
    let points: readonly LayoutPoint[];
    if (route.kind === 'direct') {
      const lane = horizontalAllocation.lanes.get(route.horizontal);
      invariant(
        lane,
        `Connections route omitted direct lane ${route.edge.originalIndex}`,
      );
      const y = horizontalY(route.sourceCorridor, lane);
      points = [start, { x: start.x, y }, { x: end.x, y }, end];
    } else {
      const sourceLane = horizontalAllocation.lanes.get(route.sourceHorizontal);
      const targetLane = horizontalAllocation.lanes.get(route.targetHorizontal);
      const verticalLane = verticalAllocation.lanes.get(route.vertical);
      invariant(
        sourceLane,
        `Connections route omitted source lane ${route.edge.originalIndex}`,
      );
      invariant(
        targetLane,
        `Connections route omitted target lane ${route.edge.originalIndex}`,
      );
      invariant(
        verticalLane,
        `Connections route omitted vertical lane ${route.edge.originalIndex}`,
      );
      const sourceY = horizontalY(route.sourceCorridor, sourceLane);
      const targetY = horizontalY(route.targetCorridor, targetLane);
      const x = verticalX(route.channel, verticalLane);
      points = [
        start,
        { x: start.x, y: sourceY },
        { x, y: sourceY },
        { x, y: targetY },
        { x: end.x, y: targetY },
        end,
      ];
    }
    const compacted = compactPolyline(points);
    if (compacted.length < 2) {
      throw new Error(
        `Connections corridor collapsed edge ${route.edge.originalIndex}`,
      );
    }
    for (let index = 1; index < compacted.length; index += 1) {
      const previous = compacted[index - 1];
      const point = compacted[index];
      invariant(previous, `Connections route omitted point ${index - 1}`);
      invariant(point, `Connections route omitted point ${index}`);
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        (previous.x !== point.x && previous.y !== point.y)
      ) {
        throw new Error(
          `Connections corridor returned invalid edge ${route.edge.originalIndex}`,
        );
      }
    }
    const first = compacted[0];
    const last = compacted.at(-1);
    invariant(
      first,
      `Connections route omitted first point ${route.edge.originalIndex}`,
    );
    invariant(
      last,
      `Connections route omitted last point ${route.edge.originalIndex}`,
    );
    const edgeId = `edge-${route.edge.originalIndex}`;
    return {
      sourceCardId: route.edge.sourceCardId,
      targetCardId: route.edge.targetCardId,
      id: edgeId,
      sourcePortId: route.sourcePort.id,
      targetPortId: route.targetPort.id,
      sections: [
        {
          id: `${edgeId}-section-0`,
          startPoint: first,
          bendPoints: compacted.slice(1, -1),
          endPoint: last,
          incomingShape: route.sourcePort.id,
          outgoingShape: route.targetPort.id,
        },
      ],
    };
  });

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Connections corridor returned non-finite component size');
  }
  return { width, height, nodes: layoutNodes, edges: layoutEdges };
}

function isolatedNodeLayout(
  node: IndexedNode,
  metrics: ConnectionsLayoutMetrics,
): ConnectionsLayout {
  return {
    width: metrics.padding.left + metrics.nodeWidth + metrics.padding.right,
    height: metrics.padding.top + metrics.nodeHeight + metrics.padding.bottom,
    nodes: [
      {
        id: node.id,
        x: metrics.padding.left,
        y: metrics.padding.top,
        width: metrics.nodeWidth,
        height: metrics.nodeHeight,
        ports: [],
      },
    ],
    edges: [],
  };
}

function translatePoint(point: LayoutPoint, x: number, y: number): LayoutPoint {
  return { x: point.x + x, y: point.y + y };
}

export function layoutConnectionsCorridors(
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
  options: ConnectionsCorridorOptions,
): ConnectionsLayout {
  validateMetrics(metrics);
  positive(options.laneSpacing, 'laneSpacing');
  const indexed = indexedGraph(graph);
  if (indexed.nodes.length === 0) {
    if (indexed.edges.length > 0) {
      throw new Error('Connections corridor received edges without nodes');
    }
    return {
      width: metrics.padding.left + metrics.padding.right,
      height: metrics.padding.top + metrics.padding.bottom,
      nodes: [],
      edges: [],
    };
  }
  const components = connectedComponents(indexed.nodes, indexed.edges);
  const laidOut: LaidOutComponent[] = components.map((component) => {
    const nodes = component.nodeIndices.map((index) => {
      const node = indexed.nodes[index];
      invariant(node, `Connections component omitted node ${index}`);
      return node;
    });
    const edges = component.edgeIndices.map((index) => {
      const edge = indexed.edges[index];
      invariant(edge, `Connections component omitted edge ${index}`);
      return edge;
    });
    let layout: ConnectionsLayout;
    if (nodes.length === 1 && edges.length === 0) {
      const onlyNode = nodes[0];
      invariant(onlyNode, 'Connections component omitted its node');
      layout = isolatedNodeLayout(onlyNode, metrics);
    } else {
      layout = layoutGridComponent(nodes, edges, metrics, options);
    }
    return {
      component,
      layout,
    };
  });
  let totalArea = 0;
  let widest = 0;
  for (const item of laidOut) {
    totalArea += item.layout.width * item.layout.height;
    widest = Math.max(widest, item.layout.width);
  }
  if (!Number.isFinite(totalArea)) {
    throw new Error('Connections corridor returned non-finite component area');
  }
  const ordered = [...laidOut].sort(
    (left, right) =>
      right.layout.height - left.layout.height ||
      stableTextCompare(left.component.stableId, right.component.stableId),
  );
  const targetWidth = Math.max(widest, Math.sqrt(totalArea * (16 / 9)));
  const resultNodes: (ConnectionsLayoutNode | undefined)[] = Array.from(
    { length: indexed.nodes.length },
    (): ConnectionsLayoutNode | undefined => undefined,
  );
  const resultEdges: (ConnectionsLayoutEdge | undefined)[] = Array.from(
    { length: indexed.edges.length },
    (): ConnectionsLayoutEdge | undefined => undefined,
  );
  let x = metrics.padding.left;
  let y = metrics.padding.top;
  let shelfHeight = 0;
  let right = metrics.padding.left;
  let bottom = metrics.padding.top;
  for (const item of ordered) {
    if (
      x > metrics.padding.left &&
      x + item.layout.width > metrics.padding.left + targetWidth
    ) {
      x = metrics.padding.left;
      y += shelfHeight + metrics.componentSpacing;
      shelfHeight = 0;
    }
    for (const node of item.layout.nodes) {
      const originalIndex = indexed.indexById.get(node.id);
      invariant(originalIndex, `Connections packing omitted node ${node.id}`);
      resultNodes[originalIndex] = {
        ...node,
        x: node.x + x,
        y: node.y + y,
        ports: node.ports.map((port) => ({
          ...port,
          x: port.x + x,
          y: port.y + y,
        })),
      };
    }
    for (
      let localIndex = 0;
      localIndex < item.layout.edges.length;
      localIndex += 1
    ) {
      const edge = item.layout.edges[localIndex];
      const originalIndex = item.component.edgeIndices[localIndex];
      invariant(edge, `Connections packing omitted local edge ${localIndex}`);
      invariant(
        originalIndex,
        `Connections packing omitted edge index ${localIndex}`,
      );
      resultEdges[originalIndex] = {
        ...edge,
        sections: edge.sections.map((section) => ({
          ...section,
          startPoint: translatePoint(section.startPoint, x, y),
          bendPoints: section.bendPoints.map((point) =>
            translatePoint(point, x, y),
          ),
          endPoint: translatePoint(section.endPoint, x, y),
        })),
      };
    }
    right = Math.max(right, x + item.layout.width);
    bottom = Math.max(bottom, y + item.layout.height);
    shelfHeight = Math.max(shelfHeight, item.layout.height);
    x += item.layout.width + metrics.componentSpacing;
  }
  const nodes = resultNodes.map((node, index) => {
    invariant(node, `Connections corridor omitted output node ${index}`);
    return node;
  });
  const edges = resultEdges.map((edge, index) => {
    invariant(edge, `Connections corridor omitted output edge ${index}`);
    return edge;
  });
  const width = right + metrics.padding.right;
  const height = bottom + metrics.padding.bottom;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Connections corridor returned non-finite packed size');
  }
  return { width, height, nodes, edges };
}
