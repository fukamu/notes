import type {
  ConnectionsEdgePortSides,
  ConnectionsLayout,
  ConnectionsLayoutEdge,
  ConnectionsLayoutGraph,
  ConnectionsLayoutNode,
  ConnectionsLayoutPort,
  ConnectionsLayoutSection,
  ConnectionsPortSide,
  LayoutPoint,
} from '@/lib/graph/elk-layout';
import {
  createConnectionsSvgPath,
  normalizeConnectionsOrthogonalPoints,
  sampleConnectionsSvgPath,
} from '@/lib/graph/connections-path';
import { invariant } from '@/lib/shared/invariant';

export type RouteInterpretation =
  | 'orthogonal-polyline'
  | 'orthogonal-rounded'
  | 'spline-cubic';

export type RouteQuality = {
  nonFiniteValues: number;
  semanticEdgeErrors: number;
  endpointMismatches: number;
  arrowTangentErrors: number;
  sectionDiscontinuities: number;
  degenerateEdges: number;
  nodeIntrusions: number;
  clearanceIntrusions: number;
  indistinguishableMutualPairs: number;
  edgeCrossings: number;
  overlappingSegments: number;
  overlappingLength: number;
  totalRouteLength: number;
  medianRouteLength: number;
  p95RouteLength: number;
  maximumRouteLength: number;
  totalObstacleLowerBound: number;
  medianDetourRatio: number;
  p95DetourRatio: number;
  maximumDetourRatio: number;
  mutualReverseExcessLength: number;
  bendOrControlPointCount: number;
  graphBoundingArea: number;
  edges: RouteEdgeQuality[];
};

export type RouteEdgeQuality = {
  edgeId: string;
  sourceCardId: string;
  targetCardId: string;
  sourceSide: ConnectionsPortSide;
  targetSide: ConnectionsPortSide;
  routeLength: number;
  obstacleLowerBound: number;
  detourRatio: number;
  mutual: boolean;
  mutualReverseExcessLength: number;
};

export type RouteQualityOptions = Readonly<{
  expectedGraph: ConnectionsLayoutGraph;
  nodeClearance: number;
}>;

const epsilon = 1e-7;
const curveSteps = 12;

function samePoint(left: LayoutPoint, right: LayoutPoint): boolean {
  return (
    Math.abs(left.x - right.x) < epsilon && Math.abs(left.y - right.y) < epsilon
  );
}

function distance(left: LayoutPoint, right: LayoutPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function cubicPoint(
  start: LayoutPoint,
  firstControl: LayoutPoint,
  secondControl: LayoutPoint,
  end: LayoutPoint,
  progress: number,
): LayoutPoint {
  const remaining = 1 - progress;
  return {
    x:
      remaining ** 3 * start.x +
      3 * remaining ** 2 * progress * firstControl.x +
      3 * remaining * progress ** 2 * secondControl.x +
      progress ** 3 * end.x,
    y:
      remaining ** 3 * start.y +
      3 * remaining ** 2 * progress * firstControl.y +
      3 * remaining * progress ** 2 * secondControl.y +
      progress ** 3 * end.y,
  };
}

function splinePolyline(section: ConnectionsLayoutSection): LayoutPoint[] {
  const controls = [...section.bendPoints, section.endPoint];
  if (controls.length % 3 !== 0) {
    throw new Error(
      `Spline section ${section.id} has ${controls.length} non-start points`,
    );
  }
  const points = [{ ...section.startPoint }];
  let start = section.startPoint;
  for (let index = 0; index < controls.length; index += 3) {
    const firstControl = controls[index];
    const secondControl = controls[index + 1];
    const end = controls[index + 2];
    invariant(firstControl, `Missing first control at ${index}`);
    invariant(secondControl, `Missing second control at ${index + 1}`);
    invariant(end, `Missing spline end at ${index + 2}`);
    for (let step = 1; step <= curveSteps; step += 1) {
      points.push(
        cubicPoint(start, firstControl, secondControl, end, step / curveSteps),
      );
    }
    start = end;
  }
  return points;
}

function segmentCrossesRectInterior(
  start: LayoutPoint,
  end: LayoutPoint,
  node: Pick<ConnectionsLayoutNode, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  const left = node.x + epsilon;
  const right = node.x + node.width - epsilon;
  const top = node.y + epsilon;
  const bottom = node.y + node.height - epsilon;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta, low, high] of [
    [start.x, deltaX, left, right],
    [start.y, deltaY, top, bottom],
  ] as const) {
    if (Math.abs(delta) < epsilon) {
      if (origin <= low || origin >= high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

function splineSectionPath(section: ConnectionsLayoutSection): string {
  const controls = [...section.bendPoints, section.endPoint];
  if (controls.length % 3 !== 0) {
    throw new Error(`Spline section ${section.id} cannot form cubic triplets`);
  }
  const commands = [`M ${section.startPoint.x} ${section.startPoint.y}`];
  for (let index = 0; index < controls.length; index += 3) {
    const first = controls[index];
    const second = controls[index + 1];
    const end = controls[index + 2];
    invariant(first, `Missing first spline control ${index}`);
    invariant(second, `Missing second spline control ${index + 1}`);
    invariant(end, `Missing spline end ${index + 2}`);
    commands.push(
      `C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`,
    );
  }
  return commands.join(' ');
}

function edgeGeometry(
  edge: ConnectionsLayoutEdge,
  nodes: ConnectionsLayoutNode[],
  interpretation: RouteInterpretation,
): { paths: string[]; polylines: LayoutPoint[][] } {
  if (interpretation === 'spline-cubic') {
    return {
      paths: edge.sections.map(splineSectionPath),
      polylines: edge.sections.map(splinePolyline),
    };
  }
  if (interpretation === 'orthogonal-rounded') {
    const rounded = edge.sections.map((section) =>
      createConnectionsSvgPath(section, {
        maximumRadius: 16,
        nodeClearance: 44,
      }),
    );
    return {
      paths: rounded.map(({ d }) => d),
      polylines: rounded.map((path) =>
        sampleConnectionsSvgPath(path, curveSteps),
      ),
    };
  }
  return {
    paths: edge.sections.map((section) => {
      const points = normalizeConnectionsOrthogonalPoints(section);
      return points
        .map(
          (point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`,
        )
        .join(' ');
    }),
    polylines: edge.sections.map(normalizeConnectionsOrthogonalPoints),
  };
}

function pointOnPortAttachment(
  point: LayoutPoint,
  port: ConnectionsLayoutPort,
  _endpoint: 'source' | 'target',
): boolean {
  const withinX =
    point.x >= port.x - epsilon && point.x <= port.x + port.width + epsilon;
  const withinY =
    point.y >= port.y - epsilon && point.y <= port.y + port.height + epsilon;
  switch (port.side) {
    case 'NORTH':
      return withinX && Math.abs(point.y - port.y) < epsilon;
    case 'EAST':
      return withinY && Math.abs(point.x - port.x - port.width) < epsilon;
    case 'SOUTH':
      return withinX && Math.abs(point.y - port.y - port.height) < epsilon;
    case 'WEST':
      return withinY && Math.abs(point.x - port.x) < epsilon;
  }
}

function tangentMatchesSide(
  start: LayoutPoint,
  end: LayoutPoint,
  side: ConnectionsPortSide,
  endpoint: 'source' | 'target',
): boolean {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.hypot(deltaX, deltaY) < epsilon) return false;
  const direction = endpoint === 'source' ? 1 : -1;
  switch (side) {
    case 'NORTH':
      return Math.abs(deltaX) < epsilon && deltaY * direction < 0;
    case 'EAST':
      return Math.abs(deltaY) < epsilon && deltaX * direction > 0;
    case 'SOUTH':
      return Math.abs(deltaX) < epsilon && deltaY * direction > 0;
    case 'WEST':
      return Math.abs(deltaY) < epsilon && deltaX * direction < 0;
  }
}

export function relativeConnectionsPortSides(
  graph: ConnectionsLayoutGraph,
  nodes: ConnectionsLayoutNode[],
): ConnectionsEdgePortSides[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge) => {
    const source = nodeById.get(edge.sourceCardId);
    const target = nodeById.get(edge.targetCardId);
    invariant(source, `Missing relative source ${edge.sourceCardId}`);
    invariant(target, `Missing relative target ${edge.targetCardId}`);
    if (source.id === target.id) return { source: 'EAST', target: 'SOUTH' };
    const deltaX = target.x + target.width / 2 - (source.x + source.width / 2);
    const deltaY =
      target.y + target.height / 2 - (source.y + source.height / 2);
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      return deltaX >= 0
        ? { source: 'EAST', target: 'WEST' }
        : { source: 'WEST', target: 'EAST' };
    }
    return deltaY >= 0
      ? { source: 'SOUTH', target: 'NORTH' }
      : { source: 'NORTH', target: 'SOUTH' };
  });
}

function properIntersection(
  firstStart: LayoutPoint,
  firstEnd: LayoutPoint,
  secondStart: LayoutPoint,
  secondEnd: LayoutPoint,
): boolean {
  const firstX = firstEnd.x - firstStart.x;
  const firstY = firstEnd.y - firstStart.y;
  const secondX = secondEnd.x - secondStart.x;
  const secondY = secondEnd.y - secondStart.y;
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < epsilon) return false;
  const offsetX = secondStart.x - firstStart.x;
  const offsetY = secondStart.y - firstStart.y;
  const firstProgress = (offsetX * secondY - offsetY * secondX) / denominator;
  const secondProgress = (offsetX * firstY - offsetY * firstX) / denominator;
  return (
    firstProgress > epsilon &&
    firstProgress < 1 - epsilon &&
    secondProgress > epsilon &&
    secondProgress < 1 - epsilon
  );
}

function collinearOverlapLength(
  firstStart: LayoutPoint,
  firstEnd: LayoutPoint,
  secondStart: LayoutPoint,
  secondEnd: LayoutPoint,
): number {
  const firstX = firstEnd.x - firstStart.x;
  const firstY = firstEnd.y - firstStart.y;
  const secondStartX = secondStart.x - firstStart.x;
  const secondStartY = secondStart.y - firstStart.y;
  const secondEndX = secondEnd.x - firstStart.x;
  const secondEndY = secondEnd.y - firstStart.y;
  if (
    Math.abs(firstX * secondStartY - firstY * secondStartX) >= epsilon ||
    Math.abs(firstX * secondEndY - firstY * secondEndX) >= epsilon
  ) {
    return 0;
  }
  const firstLength = distance(firstStart, firstEnd);
  if (firstLength < epsilon) return 0;
  const axis = Math.abs(firstX) >= Math.abs(firstY) ? 'x' : 'y';
  const firstLow = Math.min(firstStart[axis], firstEnd[axis]);
  const firstHigh = Math.max(firstStart[axis], firstEnd[axis]);
  const secondLow = Math.min(secondStart[axis], secondEnd[axis]);
  const secondHigh = Math.max(secondStart[axis], secondEnd[axis]);
  const overlap =
    Math.min(firstHigh, secondHigh) - Math.max(firstLow, secondLow);
  if (overlap <= epsilon) return 0;
  const axisLength = Math.abs(firstEnd[axis] - firstStart[axis]);
  return overlap * (firstLength / axisLength);
}

type ClearanceRect = Readonly<{
  left: number;
  right: number;
  top: number;
  bottom: number;
}>;

type DistanceEntry = Readonly<{ index: number; distance: number }>;

function inflatedNode(
  node: ConnectionsLayoutNode,
  clearance: number,
): ClearanceRect {
  return {
    left: node.x - clearance,
    right: node.x + node.width + clearance,
    top: node.y - clearance,
    bottom: node.y + node.height + clearance,
  };
}

function pointInsideRect(point: LayoutPoint, rect: ClearanceRect): boolean {
  return (
    point.x > rect.left + epsilon &&
    point.x < rect.right - epsilon &&
    point.y > rect.top + epsilon &&
    point.y < rect.bottom - epsilon
  );
}

function segmentCrossesClearanceInterior(
  start: LayoutPoint,
  end: LayoutPoint,
  rect: ClearanceRect,
): boolean {
  return segmentCrossesRectInterior(start, end, {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  });
}

function pushDistance(heap: DistanceEntry[], entry: DistanceEntry): void {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentEntry = heap[parent];
    invariant(parentEntry, `Missing distance heap parent ${parent}`);
    if (
      parentEntry.distance < entry.distance ||
      (parentEntry.distance === entry.distance &&
        parentEntry.index <= entry.index)
    ) {
      break;
    }
    heap[index] = parentEntry;
    index = parent;
  }
  heap[index] = entry;
}

function popDistance(heap: DistanceEntry[]): DistanceEntry | null {
  const root = heap[0];
  const last = heap.pop();
  if (!root || !last || heap.length === 0) return root ?? null;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const leftEntry = heap[left];
    const rightEntry = heap[right];
    invariant(leftEntry, `Missing distance heap child ${left}`);
    const next =
      rightEntry &&
      (rightEntry.distance < leftEntry.distance ||
        (rightEntry.distance === leftEntry.distance &&
          rightEntry.index < leftEntry.index))
        ? right
        : left;
    const nextEntry = heap[next];
    invariant(nextEntry, `Missing distance heap next ${next}`);
    if (
      last.distance < nextEntry.distance ||
      (last.distance === nextEntry.distance && last.index <= nextEntry.index)
    ) {
      break;
    }
    heap[index] = nextEntry;
    index = next;
  }
  heap[index] = last;
  return root;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

type RectilinearPath = Readonly<{
  distance: number;
  points: LayoutPoint[];
}>;

function obstacleAwareRectilinearPath(
  start: LayoutPoint,
  end: LayoutPoint,
  obstacles: ClearanceRect[],
): RectilinearPath | null {
  if (samePoint(start, end)) return { distance: 0, points: [start] };
  const xs = uniqueSorted([
    start.x,
    end.x,
    ...obstacles.flatMap(({ left, right }) => [left, right]),
  ]);
  const ys = uniqueSorted([
    start.y,
    end.y,
    ...obstacles.flatMap(({ top, bottom }) => [top, bottom]),
  ]);
  const points: LayoutPoint[] = [];
  const indexByCoordinate = new Map<string, number>();
  const grid: (number | undefined)[][] = [];
  for (const [yIndex, y] of ys.entries()) {
    const row: (number | undefined)[] = [];
    grid[yIndex] = row;
    for (const [xIndex, x] of xs.entries()) {
      const point = { x, y };
      if (obstacles.some((rect) => pointInsideRect(point, rect))) continue;
      indexByCoordinate.set(`${x}\u0000${y}`, points.length);
      row[xIndex] = points.length;
      points.push(point);
    }
  }
  const startIndex = indexByCoordinate.get(`${start.x}\u0000${start.y}`);
  const endIndex = indexByCoordinate.get(`${end.x}\u0000${end.y}`);
  if (startIndex === undefined)
    throw new Error('Missing lower-bound start point');
  if (endIndex === undefined) throw new Error('Missing lower-bound end point');
  const neighbors = new Map<number, DistanceEntry[]>();
  const connect = (previousIndex: number, currentIndex: number) => {
    const previousPoint = points[previousIndex];
    const currentPoint = points[currentIndex];
    invariant(previousPoint, `Missing lower-bound point ${previousIndex}`);
    invariant(currentPoint, `Missing lower-bound point ${currentIndex}`);
    if (
      obstacles.some((rect) =>
        segmentCrossesClearanceInterior(previousPoint, currentPoint, rect),
      )
    ) {
      return;
    }
    const length = distance(previousPoint, currentPoint);
    neighbors.set(previousIndex, [
      ...(neighbors.get(previousIndex) ?? []),
      { index: currentIndex, distance: length },
    ]);
    neighbors.set(currentIndex, [
      ...(neighbors.get(currentIndex) ?? []),
      { index: previousIndex, distance: length },
    ]);
  };
  for (const row of grid) {
    let previousIndex: number | undefined;
    for (const currentIndex of row) {
      if (currentIndex === undefined) continue;
      if (previousIndex !== undefined) connect(previousIndex, currentIndex);
      previousIndex = currentIndex;
    }
  }
  for (let xIndex = 0; xIndex < xs.length; xIndex += 1) {
    let previousIndex: number | undefined;
    for (const row of grid) {
      const currentIndex = row[xIndex];
      if (currentIndex === undefined) continue;
      if (previousIndex !== undefined) connect(previousIndex, currentIndex);
      previousIndex = currentIndex;
    }
  }
  const distances = Array.from({ length: points.length }, () => Infinity);
  const previous = Array.from<number | undefined>({ length: points.length });
  distances[startIndex] = 0;
  const heap: DistanceEntry[] = [];
  pushDistance(heap, { index: startIndex, distance: 0 });
  while (heap.length > 0) {
    const current = popDistance(heap);
    invariant(current, 'Distance heap unexpectedly empty');
    if (current.distance !== distances[current.index]) continue;
    if (current.index === endIndex) {
      const reversed: LayoutPoint[] = [];
      let index: number | undefined = endIndex;
      while (index !== undefined) {
        const point: LayoutPoint | undefined = points[index];
        invariant(point, `Missing shortest-path point ${index}`);
        reversed.push(point);
        index = previous[index];
      }
      return { distance: current.distance, points: reversed.reverse() };
    }
    for (const neighbor of neighbors.get(current.index) ?? []) {
      const nextDistance = current.distance + neighbor.distance;
      const known = distances[neighbor.index];
      if (known === undefined)
        throw new Error(`Missing distance ${neighbor.index}`);
      if (nextDistance >= known) continue;
      distances[neighbor.index] = nextDistance;
      previous[neighbor.index] = current.index;
      pushDistance(heap, { index: neighbor.index, distance: nextDistance });
    }
  }
  return null;
}

function obstacleAwareRectilinearDistance(
  start: LayoutPoint,
  end: LayoutPoint,
  obstacles: ClearanceRect[],
): number {
  return (
    obstacleAwareRectilinearPath(start, end, obstacles)?.distance ?? Infinity
  );
}

function portOnSide(
  node: ConnectionsLayoutNode,
  port: Pick<ConnectionsLayoutPort, 'id' | 'width' | 'height'>,
  side: ConnectionsPortSide,
): ConnectionsLayoutPort {
  switch (side) {
    case 'NORTH':
      return {
        ...port,
        side,
        x: node.x + (node.width - port.width) / 2,
        y: node.y - port.height,
      };
    case 'EAST':
      return {
        ...port,
        side,
        x: node.x + node.width,
        y: node.y + (node.height - port.height) / 2,
      };
    case 'SOUTH':
      return {
        ...port,
        side,
        x: node.x + (node.width - port.width) / 2,
        y: node.y + node.height,
      };
    case 'WEST':
      return {
        ...port,
        side,
        x: node.x - port.width,
        y: node.y + (node.height - port.height) / 2,
      };
  }
}

function portAttachment(port: ConnectionsLayoutPort): LayoutPoint {
  switch (port.side) {
    case 'NORTH':
      return { x: port.x + port.width / 2, y: port.y };
    case 'EAST':
      return { x: port.x + port.width, y: port.y + port.height / 2 };
    case 'SOUTH':
      return { x: port.x + port.width / 2, y: port.y + port.height };
    case 'WEST':
      return { x: port.x, y: port.y + port.height / 2 };
  }
}

function clearanceStub(
  node: ConnectionsLayoutNode,
  port: ConnectionsLayoutPort,
  clearance: number,
): LayoutPoint {
  const attachment = portAttachment(port);
  switch (port.side) {
    case 'NORTH':
      return { x: attachment.x, y: node.y - clearance };
    case 'EAST':
      return { x: node.x + node.width + clearance, y: attachment.y };
    case 'SOUTH':
      return { x: attachment.x, y: node.y + node.height + clearance };
    case 'WEST':
      return { x: node.x - clearance, y: attachment.y };
  }
}

function withoutRedundantPoints(points: LayoutPoint[]): LayoutPoint[] {
  const distinct = points.filter(
    (point, index) =>
      index === 0 || !samePoint(point, points[index - 1] ?? point),
  );
  const result: LayoutPoint[] = [];
  for (const point of distinct) {
    const previous = result.at(-1);
    const beforePrevious = result.at(-2);
    if (previous && beforePrevious) {
      const firstX = previous.x - beforePrevious.x;
      const firstY = previous.y - beforePrevious.y;
      const secondX = point.x - previous.x;
      const secondY = point.y - previous.y;
      if (
        Math.abs(firstX * secondY - firstY * secondX) < epsilon &&
        firstX * secondX + firstY * secondY >= 0
      ) {
        result[result.length - 1] = point;
        continue;
      }
    }
    result.push(point);
  }
  return result;
}

type VisibilityEdgeRoute = Readonly<{
  sourcePort: ConnectionsLayoutPort;
  targetPort: ConnectionsLayoutPort;
  points: LayoutPoint[];
  distance: number;
}>;

function visibilityEdgeRoute(
  edge: ConnectionsLayoutEdge,
  source: ConnectionsLayoutNode,
  target: ConnectionsLayoutNode,
  nodes: ConnectionsLayoutNode[],
  ports: ReadonlyMap<string, ConnectionsLayoutPort>,
  clearance: number,
  sides: ConnectionsEdgePortSides,
): VisibilityEdgeRoute {
  const originalSourcePort = ports.get(edge.sourcePortId);
  const originalTargetPort = ports.get(edge.targetPortId);
  invariant(originalSourcePort, `Missing source port ${edge.sourcePortId}`);
  invariant(originalTargetPort, `Missing target port ${edge.targetPortId}`);
  const obstacles = nodes.map((node) => inflatedNode(node, clearance));
  const sourcePort = portOnSide(source, originalSourcePort, sides.source);
  const targetPort = portOnSide(target, originalTargetPort, sides.target);
  const sourceAttachment = portAttachment(sourcePort);
  const targetAttachment = portAttachment(targetPort);
  const sourceStub = clearanceStub(source, sourcePort, clearance);
  const targetStub = clearanceStub(target, targetPort, clearance);
  const path = obstacleAwareRectilinearPath(sourceStub, targetStub, obstacles);
  invariant(path, `Visibility routing failed for ${edge.id}`);
  return {
    sourcePort,
    targetPort,
    points: withoutRedundantPoints([
      sourceAttachment,
      ...path.points,
      targetAttachment,
    ]),
    distance:
      distance(sourceAttachment, sourceStub) +
      path.distance +
      distance(targetStub, targetAttachment),
  };
}

export function routeConnectionsWithVisibilityGraph(
  layout: ConnectionsLayout,
  graph: ConnectionsLayoutGraph,
  clearance: number,
): ConnectionsLayout {
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const originalPorts = new Map(
    layout.nodes.flatMap((node) =>
      node.ports.map((port) => [port.id, port] as const),
    ),
  );
  const routedPorts = new Map<string, ConnectionsLayoutPort>();
  const sides = relativeConnectionsPortSides(graph, layout.nodes);
  const edges = layout.edges.map((edge, index): ConnectionsLayoutEdge => {
    const expected = graph.edges[index];
    invariant(expected, `Missing expected visibility edge ${index}`);
    if (
      expected.sourceCardId !== edge.sourceCardId ||
      expected.targetCardId !== edge.targetCardId
    ) {
      throw new Error(`Visibility routing semantic edge mismatch at ${index}`);
    }
    const source = nodeById.get(edge.sourceCardId);
    const target = nodeById.get(edge.targetCardId);
    invariant(source, `Missing visibility source ${edge.sourceCardId}`);
    invariant(target, `Missing visibility target ${edge.targetCardId}`);
    const edgeSides = sides[index];
    invariant(edgeSides, `Missing visibility port sides ${index}`);
    const route = visibilityEdgeRoute(
      edge,
      source,
      target,
      layout.nodes,
      originalPorts,
      clearance,
      edgeSides,
    );
    routedPorts.set(route.sourcePort.id, route.sourcePort);
    routedPorts.set(route.targetPort.id, route.targetPort);
    const startPoint = route.points[0];
    const endPoint = route.points.at(-1);
    invariant(startPoint, `Missing visibility start ${edge.id}`);
    invariant(endPoint, `Missing visibility end ${edge.id}`);
    return {
      ...edge,
      sections: [
        {
          id: `${edge.id}-visibility`,
          startPoint,
          bendPoints: route.points.slice(1, -1),
          endPoint,
          incomingShape: edge.sourcePortId,
          outgoingShape: edge.targetPortId,
        },
      ],
    };
  });
  const nodes = layout.nodes.map((node) => ({
    ...node,
    ports: node.ports.map((port) => routedPorts.get(port.id) ?? port),
  }));
  return { ...layout, nodes, edges };
}

type RouteSegment = {
  edgeIndex: number;
  start: LayoutPoint;
  end: LayoutPoint;
};

export function serializeLayoutPaths(
  layout: ConnectionsLayout,
  interpretation: RouteInterpretation,
): string[] {
  return layout.edges.flatMap(
    (edge) => edgeGeometry(edge, layout.nodes, interpretation).paths,
  );
}

export function measureRouteQuality(
  layout: ConnectionsLayout,
  interpretation: RouteInterpretation,
  options: RouteQualityOptions,
): RouteQuality {
  let nonFiniteValues = 0;
  let arrowTangentErrors = 0;
  let endpointMismatches = 0;
  let sectionDiscontinuities = 0;
  let degenerateEdges = 0;
  let nodeIntrusions = 0;
  let clearanceIntrusions = 0;
  let totalRouteLength = 0;
  let bendOrControlPointCount = 0;
  const segments: RouteSegment[] = [];
  const routeLengths: number[] = [];
  const detourRatios: number[] = [];
  const edgeQualities: RouteEdgeQuality[] = [];
  const routeKeys: string[][] = [];
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const portById = new Map(
    layout.nodes.flatMap((node) =>
      node.ports.map((port) => [port.id, port] as const),
    ),
  );

  for (const value of [layout.width, layout.height]) {
    if (!Number.isFinite(value)) nonFiniteValues += 1;
  }
  for (const node of layout.nodes) {
    for (const value of [node.x, node.y, node.width, node.height]) {
      if (!Number.isFinite(value)) nonFiniteValues += 1;
    }
  }
  const expectedEdges = new Map<string, number>();
  const actualEdges = new Map<string, number>();
  const semanticKey = (source: string, target: string) =>
    `${source}\u0000${target}`;
  for (const edge of options.expectedGraph.edges) {
    const key = semanticKey(edge.sourceCardId, edge.targetCardId);
    expectedEdges.set(key, (expectedEdges.get(key) ?? 0) + 1);
  }
  for (const edge of layout.edges) {
    const key = semanticKey(edge.sourceCardId, edge.targetCardId);
    actualEdges.set(key, (actualEdges.get(key) ?? 0) + 1);
  }
  let semanticEdgeErrors = 0;
  for (const key of new Set([...expectedEdges.keys(), ...actualEdges.keys()])) {
    semanticEdgeErrors += Math.abs(
      (expectedEdges.get(key) ?? 0) - (actualEdges.get(key) ?? 0),
    );
  }
  for (const [edgeIndex, edge] of layout.edges.entries()) {
    const source = nodeById.get(edge.sourceCardId);
    const target = nodeById.get(edge.targetCardId);
    const firstSection = edge.sections[0];
    const lastSection = edge.sections.at(-1);
    invariant(source, `Missing source node for ${edge.id}`);
    invariant(target, `Missing target node for ${edge.id}`);
    invariant(firstSection, `Missing first section for ${edge.id}`);
    invariant(lastSection, `Missing last section for ${edge.id}`);
    const sourcePort = portById.get(edge.sourcePortId);
    const targetPort = portById.get(edge.targetPortId);
    invariant(sourcePort, `Missing source port ${edge.sourcePortId}`);
    invariant(targetPort, `Missing target port ${edge.targetPortId}`);
    if (!pointOnPortAttachment(firstSection.startPoint, sourcePort, 'source'))
      endpointMismatches += 1;
    if (!pointOnPortAttachment(lastSection.endPoint, targetPort, 'target'))
      endpointMismatches += 1;
    for (let index = 1; index < edge.sections.length; index += 1) {
      const previous = edge.sections[index - 1];
      const current = edge.sections[index];
      invariant(previous, `Missing previous section ${index - 1}`);
      invariant(current, `Missing current section ${index}`);
      if (!samePoint(previous.endPoint, current.startPoint)) {
        sectionDiscontinuities += 1;
      }
    }
    bendOrControlPointCount += edge.sections.reduce(
      (total, section) => total + section.bendPoints.length,
      0,
    );
    const geometry = edgeGeometry(edge, layout.nodes, interpretation);
    const otherNodes = layout.nodes.filter(
      (node) => node.id !== edge.sourceCardId && node.id !== edge.targetCardId,
    );
    let edgeIntrudes = false;
    let edgeClearanceIntrudes = false;
    let edgeLength = 0;
    const edgeRoutePoints: LayoutPoint[] = [];
    for (const polyline of geometry.polylines) {
      edgeRoutePoints.push(...polyline);
      for (const point of polyline) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          nonFiniteValues += 1;
        }
      }
      for (let index = 1; index < polyline.length; index += 1) {
        const start = polyline[index - 1];
        const end = polyline[index];
        invariant(start, `Missing route start ${index - 1}`);
        invariant(end, `Missing route end ${index}`);
        const segmentLength = distance(start, end);
        totalRouteLength += segmentLength;
        edgeLength += segmentLength;
        segments.push({ edgeIndex, start, end });
        if (
          !edgeIntrudes &&
          otherNodes.some((node) =>
            segmentCrossesRectInterior(start, end, node),
          )
        ) {
          edgeIntrudes = true;
        }
        if (
          !edgeClearanceIntrudes &&
          otherNodes.some((node) =>
            segmentCrossesClearanceInterior(
              start,
              end,
              inflatedNode(node, options.nodeClearance),
            ),
          )
        ) {
          edgeClearanceIntrudes = true;
        }
      }
    }
    if (edgeIntrudes) nodeIntrusions += 1;
    if (edgeClearanceIntrudes) clearanceIntrusions += 1;
    const firstPolyline = geometry.polylines[0];
    const lastPolyline = geometry.polylines.at(-1);
    const sourceStart = firstPolyline?.[0];
    const sourceNext = firstPolyline?.[1];
    const targetEnd = lastPolyline?.at(-1);
    const targetPrevious = lastPolyline?.at(-2);
    if (
      !sourceStart ||
      !sourceNext ||
      !tangentMatchesSide(sourceStart, sourceNext, sourcePort.side, 'source')
    ) {
      arrowTangentErrors += 1;
    }
    if (
      !targetPrevious ||
      !targetEnd ||
      !tangentMatchesSide(targetPrevious, targetEnd, targetPort.side, 'target')
    ) {
      arrowTangentErrors += 1;
    }
    if (
      edgeLength < epsilon ||
      new Set(edgeRoutePoints.map(({ x, y }) => `${x}\u0000${y}`)).size < 2
    ) {
      degenerateEdges += 1;
    }
    const obstacles = otherNodes.map((node) =>
      inflatedNode(node, options.nodeClearance),
    );
    const lowerBound = obstacleAwareRectilinearDistance(
      firstSection.startPoint,
      lastSection.endPoint,
      obstacles,
    );
    const detourRatio =
      lowerBound > epsilon ? edgeLength / lowerBound : edgeLength > 0 ? 1 : 0;
    const mutual = options.expectedGraph.edges.some(
      (candidate) =>
        candidate.sourceCardId === edge.targetCardId &&
        candidate.targetCardId === edge.sourceCardId,
    );
    const mutualExcess = mutual ? Math.max(0, edgeLength - lowerBound) : 0;
    routeLengths.push(edgeLength);
    detourRatios.push(detourRatio);
    edgeQualities.push({
      edgeId: edge.id,
      sourceCardId: edge.sourceCardId,
      targetCardId: edge.targetCardId,
      sourceSide: sourcePort.side,
      targetSide: targetPort.side,
      routeLength: edgeLength,
      obstacleLowerBound: lowerBound,
      detourRatio,
      mutual,
      mutualReverseExcessLength: mutualExcess,
    });
    routeKeys.push(
      edgeRoutePoints.map(
        ({ x, y }) => `${Math.round(x * 1e6)}:${Math.round(y * 1e6)}`,
      ),
    );
  }

  let indistinguishableMutualPairs = 0;
  for (let left = 0; left < layout.edges.length; left += 1) {
    const leftEdge = layout.edges[left];
    const leftRoute = routeKeys[left];
    invariant(leftEdge, `Missing mutual edge ${left}`);
    invariant(leftRoute, `Missing mutual route ${left}`);
    for (let right = left + 1; right < layout.edges.length; right += 1) {
      const rightEdge = layout.edges[right];
      const rightRoute = routeKeys[right];
      invariant(rightEdge, `Missing mutual edge ${right}`);
      invariant(rightRoute, `Missing mutual route ${right}`);
      if (
        leftEdge.sourceCardId !== rightEdge.targetCardId ||
        leftEdge.targetCardId !== rightEdge.sourceCardId
      ) {
        continue;
      }
      if (leftRoute.join('|') === [...rightRoute].reverse().join('|')) {
        indistinguishableMutualPairs += 1;
      }
    }
  }

  let edgeCrossings = 0;
  let overlappingSegments = 0;
  let overlappingLength = 0;
  const cellSize = 64;
  const buckets = new Map<string, number[]>();
  for (const [index, segment] of segments.entries()) {
    const minimumX = Math.floor(
      Math.min(segment.start.x, segment.end.x) / cellSize,
    );
    const maximumX = Math.floor(
      Math.max(segment.start.x, segment.end.x) / cellSize,
    );
    const minimumY = Math.floor(
      Math.min(segment.start.y, segment.end.y) / cellSize,
    );
    const maximumY = Math.floor(
      Math.max(segment.start.y, segment.end.y) / cellSize,
    );
    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let y = minimumY; y <= maximumY; y += 1) {
        const key = `${x},${y}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(index);
        buckets.set(key, bucket);
      }
    }
  }
  const measuredPairs = new Set<string>();
  for (const bucket of buckets.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      const firstIndex = bucket[left];
      invariant(firstIndex, `Missing bucket segment ${left}`);
      const first = segments[firstIndex];
      invariant(first, `Missing route segment ${firstIndex}`);
      for (let right = left + 1; right < bucket.length; right += 1) {
        const secondIndex = bucket[right];
        invariant(secondIndex, `Missing bucket segment ${right}`);
        if (firstIndex === secondIndex) continue;
        const pairKey =
          firstIndex < secondIndex
            ? `${firstIndex}:${secondIndex}`
            : `${secondIndex}:${firstIndex}`;
        if (measuredPairs.has(pairKey)) continue;
        measuredPairs.add(pairKey);
        const second: RouteSegment | undefined = segments[secondIndex];
        invariant(second, `Missing route segment ${secondIndex}`);
        if (first.edgeIndex === second.edgeIndex) continue;
        if (
          properIntersection(first.start, first.end, second.start, second.end)
        ) {
          edgeCrossings += 1;
        }
        const overlap = collinearOverlapLength(
          first.start,
          first.end,
          second.start,
          second.end,
        );
        if (overlap > epsilon) {
          overlappingSegments += 1;
          overlappingLength += overlap;
        }
      }
    }
  }

  const lengthDistribution = distribution(routeLengths);
  const detourDistribution = distribution(detourRatios);

  return {
    nonFiniteValues,
    semanticEdgeErrors,
    endpointMismatches,
    arrowTangentErrors,
    sectionDiscontinuities,
    degenerateEdges,
    nodeIntrusions,
    clearanceIntrusions,
    indistinguishableMutualPairs,
    edgeCrossings,
    overlappingSegments,
    overlappingLength,
    totalRouteLength,
    medianRouteLength: lengthDistribution.median,
    p95RouteLength: lengthDistribution.p95,
    maximumRouteLength: lengthDistribution.maximum,
    totalObstacleLowerBound: edgeQualities.reduce(
      (total, edge) => total + edge.obstacleLowerBound,
      0,
    ),
    medianDetourRatio: detourDistribution.median,
    p95DetourRatio: detourDistribution.p95,
    maximumDetourRatio: detourDistribution.maximum,
    mutualReverseExcessLength: edgeQualities.reduce(
      (total, edge) => total + edge.mutualReverseExcessLength,
      0,
    ),
    bendOrControlPointCount,
    graphBoundingArea: layout.width * layout.height,
    edges: edgeQualities,
  };
}

export function distribution(samples: number[]): {
  median: number;
  p95: number;
  minimum: number;
  maximum: number;
} {
  if (samples.length === 0) throw new Error('Distribution needs samples');
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (quantile: number) => {
    const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
    const value = sorted[index];
    invariant(value, `Missing percentile sample ${index}`);
    return value;
  };
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  invariant(minimum, 'Missing minimum sample');
  invariant(maximum, 'Missing maximum sample');
  return { median: at(0.5), p95: at(0.95), minimum, maximum };
}
