import type { CardId } from '@/lib/domain/id';
import {
  fullNetworkLayoutKey,
  validateFullNetworkLayout,
  type FullNetworkLayout,
  type FullNetworkLayoutConfiguration,
  type FullNetworkTopology,
} from '@/lib/graph/full-network-layout';

export type FullNetworkRoutingConfiguration = Readonly<{
  version: 1;
  nodeHalfWidth: number;
  nodeHalfHeight: number;
}>;

export const defaultFullNetworkRoutingConfiguration = {
  version: 1,
  nodeHalfWidth: 3,
  nodeHalfHeight: 2,
} as const satisfies FullNetworkRoutingConfiguration;

export type FullNetworkViewport = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

export type FullNetworkDirectedEdgeIdentity = Readonly<{
  edgeIndex: number;
  id: string;
  sourceCardId: CardId;
  targetCardId: CardId;
}>;

export type FullNetworkRoute = FullNetworkDirectedEdgeIdentity &
  Readonly<{
    coordinates: Float32Array;
  }>;

export type FullNetworkRouting = Readonly<{
  routingKey: string;
  topologyKey: string;
  layoutKey: string;
  routeCount: number;
  bounds: FullNetworkViewport;
  minimumX: Float32Array;
  minimumY: Float32Array;
  maximumX: Float32Array;
  maximumY: Float32Array;
  edgeIndexesByMinimumX: Uint32Array;
  prefixMaximumX: Float32Array;
  topology: FullNetworkTopology;
  layout: FullNetworkLayout;
  layoutConfiguration: FullNetworkLayoutConfiguration;
  routingConfiguration: FullNetworkRoutingConfiguration;
}>;

const maximumNodes = 10_000;

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

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function validateRoutingConfiguration(
  routing: FullNetworkRoutingConfiguration,
  layout: FullNetworkLayoutConfiguration,
): void {
  if (routing.version !== 1) {
    throw new RangeError('Unsupported full-network routing version');
  }
  const nodeHalfWidth = positiveFinite(routing.nodeHalfWidth, 'nodeHalfWidth');
  const nodeHalfHeight = positiveFinite(
    routing.nodeHalfHeight,
    'nodeHalfHeight',
  );
  if (
    nodeHalfWidth >= layout.cellWidth / 2 ||
    nodeHalfHeight >= layout.cellHeight / 2
  ) {
    throw new RangeError(
      'Full-network node clearance must remain inside its layout cell',
    );
  }
}

function edgeEndpoints(
  topology: FullNetworkTopology,
  edgeIndex: number,
): Readonly<{ source: number; target: number }> {
  if (!Number.isSafeInteger(edgeIndex) || edgeIndex < 0) {
    throw new RangeError('Full-network edge index must be non-negative');
  }
  if (edgeIndex >= topology.sources.length) {
    throw new RangeError(`Full-network edge ${edgeIndex} is out of range`);
  }
  const source = typedValue(topology.sources, edgeIndex, 'route source');
  const target = typedValue(topology.targets, edgeIndex, 'route target');
  if (source >= topology.nodeIds.length || target >= topology.nodeIds.length) {
    throw new RangeError(
      `Full-network edge ${edgeIndex} has invalid endpoints`,
    );
  }
  return { source, target };
}

function cardId(
  topology: FullNetworkTopology,
  nodeIndex: number,
  label: string,
): CardId {
  const value = topology.nodeIds[nodeIndex];
  if (value === undefined) throw new Error(`Missing ${label} at ${nodeIndex}`);
  return value;
}

function routeDirection(
  topology: FullNetworkTopology,
  source: number,
  target: number,
): 1 | -1 {
  if (source === target) return 1;
  return cardId(topology, source, 'source card').localeCompare(
    cardId(topology, target, 'target card'),
  ) < 0
    ? 1
    : -1;
}

function appendCoordinate(coordinates: number[], x: number, y: number): void {
  const length = coordinates.length;
  if (
    length >= 2 &&
    coordinates[length - 2] === x &&
    coordinates[length - 1] === y
  ) {
    return;
  }
  coordinates.push(x, y);
}

function routeCoordinatesAt(
  topology: FullNetworkTopology,
  layout: FullNetworkLayout,
  layoutConfiguration: FullNetworkLayoutConfiguration,
  edgeIndex: number,
): Float32Array {
  const { source, target } = edgeEndpoints(topology, edgeIndex);
  const sourceX = typedValue(layout.x, source, 'source x');
  const sourceY = typedValue(layout.y, source, 'source y');
  const targetX = typedValue(layout.x, target, 'target x');
  const targetY = typedValue(layout.y, target, 'target y');
  const halfCellWidth = layoutConfiguration.cellWidth / 2;
  const halfCellHeight = layoutConfiguration.cellHeight / 2;
  const direction = routeDirection(topology, source, target);
  const coordinates: number[] = [];
  appendCoordinate(coordinates, sourceX, sourceY);
  if (source === target) {
    appendCoordinate(coordinates, sourceX + halfCellWidth, sourceY);
    appendCoordinate(
      coordinates,
      sourceX + halfCellWidth,
      sourceY + halfCellHeight,
    );
    appendCoordinate(
      coordinates,
      sourceX - halfCellWidth,
      sourceY + halfCellHeight,
    );
    appendCoordinate(coordinates, sourceX - halfCellWidth, sourceY);
  } else {
    const sourceLaneX = sourceX + direction * halfCellWidth;
    const targetLaneX = targetX - direction * halfCellWidth;
    const horizontalLaneY = sourceY + direction * halfCellHeight;
    appendCoordinate(coordinates, sourceLaneX, sourceY);
    appendCoordinate(coordinates, sourceLaneX, horizontalLaneY);
    appendCoordinate(coordinates, targetLaneX, horizontalLaneY);
    appendCoordinate(coordinates, targetLaneX, targetY);
  }
  appendCoordinate(coordinates, targetX, targetY);
  return Float32Array.from(coordinates);
}

function writeRouteBounds(
  topology: FullNetworkTopology,
  layout: FullNetworkLayout,
  layoutConfiguration: FullNetworkLayoutConfiguration,
  edgeIndex: number,
  minimumX: Float32Array,
  minimumY: Float32Array,
  maximumX: Float32Array,
  maximumY: Float32Array,
): void {
  const { source, target } = edgeEndpoints(topology, edgeIndex);
  const sourceX = typedValue(layout.x, source, 'source x');
  const sourceY = typedValue(layout.y, source, 'source y');
  const targetX = typedValue(layout.x, target, 'target x');
  const targetY = typedValue(layout.y, target, 'target y');
  const halfCellWidth = layoutConfiguration.cellWidth / 2;
  const halfCellHeight = layoutConfiguration.cellHeight / 2;
  if (source === target) {
    minimumX[edgeIndex] = sourceX - halfCellWidth;
    maximumX[edgeIndex] = sourceX + halfCellWidth;
    minimumY[edgeIndex] = sourceY;
    maximumY[edgeIndex] = sourceY + halfCellHeight;
    return;
  }
  const direction = routeDirection(topology, source, target);
  const sourceLaneX = sourceX + direction * halfCellWidth;
  const targetLaneX = targetX - direction * halfCellWidth;
  const horizontalLaneY = sourceY + direction * halfCellHeight;
  minimumX[edgeIndex] = Math.min(sourceX, targetX, sourceLaneX, targetLaneX);
  maximumX[edgeIndex] = Math.max(sourceX, targetX, sourceLaneX, targetLaneX);
  minimumY[edgeIndex] = Math.min(sourceY, targetY, horizontalLaneY);
  maximumY[edgeIndex] = Math.max(sourceY, targetY, horizontalLaneY);
}

function compareEdgesByMinimumX(
  left: number,
  right: number,
  minimumX: Float32Array,
): number {
  return (
    typedValue(minimumX, left, 'left minimum x') -
      typedValue(minimumX, right, 'right minimum x') || left - right
  );
}

function sortEdgesByMinimumX(minimumX: Float32Array): Uint32Array {
  const first = new Uint32Array(minimumX.length);
  const second = new Uint32Array(minimumX.length);
  for (let edge = 0; edge < first.length; edge += 1) first[edge] = edge;
  let source = first;
  let target = second;
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let left = start;
      let right = middle;
      let output = start;
      while (left < middle || right < end) {
        const leftEdge = left < middle ? source[left] : undefined;
        const rightEdge = right < end ? source[right] : undefined;
        if (
          rightEdge === undefined ||
          (leftEdge !== undefined &&
            compareEdgesByMinimumX(leftEdge, rightEdge, minimumX) <= 0)
        ) {
          if (leftEdge === undefined) {
            throw new Error('Full-network route sort omitted its left edge');
          }
          target[output] = leftEdge;
          left += 1;
        } else {
          target[output] = rightEdge;
          right += 1;
        }
        output += 1;
      }
    }
    const previous = source;
    source = target;
    target = previous;
  }
  return source;
}

function routingKey(
  layout: FullNetworkLayout,
  configuration: FullNetworkRoutingConfiguration,
): string {
  return `${layout.layoutKey}:routing-v${configuration.version}:${configuration.nodeHalfWidth}:${configuration.nodeHalfHeight}`;
}

export function createFullNetworkRouting(
  topology: FullNetworkTopology,
  layout: FullNetworkLayout,
  layoutConfiguration: FullNetworkLayoutConfiguration,
  routingConfiguration: FullNetworkRoutingConfiguration = defaultFullNetworkRoutingConfiguration,
): FullNetworkRouting {
  validateFullNetworkLayout(topology, layout);
  if (
    layout.layoutKey !== fullNetworkLayoutKey(topology, layoutConfiguration)
  ) {
    throw new Error('Full-network routing layout configuration is stale');
  }
  validateRoutingConfiguration(routingConfiguration, layoutConfiguration);
  const edgeCount = topology.sources.length;
  const minimumX = new Float32Array(edgeCount);
  const minimumY = new Float32Array(edgeCount);
  const maximumX = new Float32Array(edgeCount);
  const maximumY = new Float32Array(edgeCount);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    writeRouteBounds(
      topology,
      layout,
      layoutConfiguration,
      edge,
      minimumX,
      minimumY,
      maximumX,
      maximumY,
    );
  }
  const edgeIndexesByMinimumX = sortEdgesByMinimumX(minimumX);
  const prefixMaximumX = new Float32Array(edgeCount);
  let runningMaximumX = Number.NEGATIVE_INFINITY;
  for (let position = 0; position < edgeCount; position += 1) {
    const edge = typedValue(
      edgeIndexesByMinimumX,
      position,
      'sorted route edge',
    );
    runningMaximumX = Math.max(
      runningMaximumX,
      typedValue(maximumX, edge, 'route maximum x'),
    );
    prefixMaximumX[position] = runningMaximumX;
  }
  let bounds: FullNetworkViewport = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (edgeCount > 0) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let edge = 0; edge < edgeCount; edge += 1) {
      minX = Math.min(minX, typedValue(minimumX, edge, 'route minimum x'));
      minY = Math.min(minY, typedValue(minimumY, edge, 'route minimum y'));
      maxX = Math.max(maxX, typedValue(maximumX, edge, 'route maximum x'));
      maxY = Math.max(maxY, typedValue(maximumY, edge, 'route maximum y'));
    }
    bounds = { minX, minY, maxX, maxY };
  }
  const routing: FullNetworkRouting = {
    routingKey: routingKey(layout, routingConfiguration),
    topologyKey: topology.structuralKey,
    layoutKey: layout.layoutKey,
    routeCount: edgeCount,
    bounds,
    minimumX,
    minimumY,
    maximumX,
    maximumY,
    edgeIndexesByMinimumX,
    prefixMaximumX,
    topology,
    layout,
    layoutConfiguration,
    routingConfiguration,
  };
  validateFullNetworkRouting(routing);
  return routing;
}

export function fullNetworkDirectedEdgeIdentity(
  topology: FullNetworkTopology,
  edgeIndex: number,
): FullNetworkDirectedEdgeIdentity {
  const { source, target } = edgeEndpoints(topology, edgeIndex);
  const sourceCardId = cardId(topology, source, 'source card');
  const targetCardId = cardId(topology, target, 'target card');
  return {
    edgeIndex,
    id: `full-network-edge-v1:${sourceCardId}:${targetCardId}`,
    sourceCardId,
    targetCardId,
  };
}

export function fullNetworkRouteAt(
  routing: FullNetworkRouting,
  edgeIndex: number,
): FullNetworkRoute {
  return {
    ...fullNetworkDirectedEdgeIdentity(routing.topology, edgeIndex),
    coordinates: routeCoordinatesAt(
      routing.topology,
      routing.layout,
      routing.layoutConfiguration,
      edgeIndex,
    ),
  };
}

function validateViewport(viewport: FullNetworkViewport): void {
  finite(viewport.minX, 'viewport.minX');
  finite(viewport.minY, 'viewport.minY');
  finite(viewport.maxX, 'viewport.maxX');
  finite(viewport.maxY, 'viewport.maxY');
  if (viewport.minX > viewport.maxX || viewport.minY > viewport.maxY) {
    throw new RangeError('Full-network viewport bounds are inverted');
  }
}

function pointInViewport(
  x: number,
  y: number,
  viewport: FullNetworkViewport,
): boolean {
  return (
    x >= viewport.minX &&
    x <= viewport.maxX &&
    y >= viewport.minY &&
    y <= viewport.maxY
  );
}

function segmentIntersectsViewport(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  viewport: FullNetworkViewport,
): boolean {
  if (
    pointInViewport(fromX, fromY, viewport) ||
    pointInViewport(toX, toY, viewport)
  ) {
    return true;
  }
  if (fromX === toX) {
    return (
      fromX >= viewport.minX &&
      fromX <= viewport.maxX &&
      Math.max(fromY, toY) >= viewport.minY &&
      Math.min(fromY, toY) <= viewport.maxY
    );
  }
  if (fromY === toY) {
    return (
      fromY >= viewport.minY &&
      fromY <= viewport.maxY &&
      Math.max(fromX, toX) >= viewport.minX &&
      Math.min(fromX, toX) <= viewport.maxX
    );
  }
  throw new Error('Full-network route contains a diagonal segment');
}

function routeIntersectsViewport(
  routing: FullNetworkRouting,
  edgeIndex: number,
  viewport: FullNetworkViewport,
): boolean {
  const coordinates = routeCoordinatesAt(
    routing.topology,
    routing.layout,
    routing.layoutConfiguration,
    edgeIndex,
  );
  for (let offset = 0; offset + 3 < coordinates.length; offset += 2) {
    if (
      segmentIntersectsViewport(
        typedValue(coordinates, offset, 'route from x'),
        typedValue(coordinates, offset + 1, 'route from y'),
        typedValue(coordinates, offset + 2, 'route to x'),
        typedValue(coordinates, offset + 3, 'route to y'),
        viewport,
      )
    ) {
      return true;
    }
  }
  return false;
}

function containsViewport(
  outer: FullNetworkViewport,
  inner: FullNetworkViewport,
): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function upperBoundByMinimumX(
  routing: FullNetworkRouting,
  maximumX: number,
): number {
  let low = 0;
  let high = routing.edgeIndexesByMinimumX.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const edge = typedValue(
      routing.edgeIndexesByMinimumX,
      middle,
      'sorted route edge',
    );
    if (typedValue(routing.minimumX, edge, 'route minimum x') <= maximumX) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function queryFullNetworkRoutes(
  routing: FullNetworkRouting,
  viewport: FullNetworkViewport,
): Uint32Array {
  validateViewport(viewport);
  if (routing.routeCount === 0) return new Uint32Array();
  if (containsViewport(viewport, routing.bounds)) {
    return Uint32Array.from(
      { length: routing.routeCount },
      (_, edgeIndex) => edgeIndex,
    );
  }
  const matches: number[] = [];
  const limit = upperBoundByMinimumX(routing, viewport.maxX);
  for (let position = limit - 1; position >= 0; position -= 1) {
    if (
      typedValue(routing.prefixMaximumX, position, 'prefix maximum x') <
      viewport.minX
    ) {
      break;
    }
    const edge = typedValue(
      routing.edgeIndexesByMinimumX,
      position,
      'sorted route edge',
    );
    if (
      typedValue(routing.maximumX, edge, 'route maximum x') < viewport.minX ||
      typedValue(routing.minimumY, edge, 'route minimum y') > viewport.maxY ||
      typedValue(routing.maximumY, edge, 'route maximum y') < viewport.minY
    ) {
      continue;
    }
    if (routeIntersectsViewport(routing, edge, viewport)) matches.push(edge);
  }
  matches.sort((left, right) => left - right);
  return Uint32Array.from(matches);
}

export function fullNetworkRouteLength(route: FullNetworkRoute): number {
  let length = 0;
  for (let offset = 0; offset + 3 < route.coordinates.length; offset += 2) {
    const fromX = typedValue(route.coordinates, offset, 'route from x');
    const fromY = typedValue(route.coordinates, offset + 1, 'route from y');
    const toX = typedValue(route.coordinates, offset + 2, 'route to x');
    const toY = typedValue(route.coordinates, offset + 3, 'route to y');
    if (fromX !== toX && fromY !== toY) {
      throw new Error('Full-network route contains a diagonal segment');
    }
    length += Math.abs(toX - fromX) + Math.abs(toY - fromY);
  }
  return length;
}

export function fullNetworkRouteIntersectsNodeInterior(
  route: FullNetworkRoute,
  layout: FullNetworkLayout,
  nodeIndex: number,
  configuration: FullNetworkRoutingConfiguration,
): boolean {
  if (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0) {
    throw new RangeError('Full-network node index must be non-negative');
  }
  const centerX = typedValue(layout.x, nodeIndex, 'node center x');
  const centerY = typedValue(layout.y, nodeIndex, 'node center y');
  const minX = centerX - configuration.nodeHalfWidth;
  const maxX = centerX + configuration.nodeHalfWidth;
  const minY = centerY - configuration.nodeHalfHeight;
  const maxY = centerY + configuration.nodeHalfHeight;
  for (let offset = 0; offset + 3 < route.coordinates.length; offset += 2) {
    const fromX = typedValue(route.coordinates, offset, 'route from x');
    const fromY = typedValue(route.coordinates, offset + 1, 'route from y');
    const toX = typedValue(route.coordinates, offset + 2, 'route to x');
    const toY = typedValue(route.coordinates, offset + 3, 'route to y');
    if (
      (fromX === toX &&
        fromX > minX &&
        fromX < maxX &&
        Math.max(fromY, toY) > minY &&
        Math.min(fromY, toY) < maxY) ||
      (fromY === toY &&
        fromY > minY &&
        fromY < maxY &&
        Math.max(fromX, toX) > minX &&
        Math.min(fromX, toX) < maxX)
    ) {
      return true;
    }
  }
  return false;
}

export function fullNetworkRoutingIndexBytes(
  routing: FullNetworkRouting,
): number {
  return (
    routing.minimumX.byteLength +
    routing.minimumY.byteLength +
    routing.maximumX.byteLength +
    routing.maximumY.byteLength +
    routing.edgeIndexesByMinimumX.byteLength +
    routing.prefixMaximumX.byteLength
  );
}

export function validateFullNetworkRouting(routing: FullNetworkRouting): void {
  const edgeCount = routing.topology.sources.length;
  if (
    routing.topologyKey !== routing.topology.structuralKey ||
    routing.layoutKey !== routing.layout.layoutKey ||
    routing.routingKey !==
      routingKey(routing.layout, routing.routingConfiguration) ||
    routing.routeCount !== edgeCount ||
    routing.minimumX.length !== edgeCount ||
    routing.minimumY.length !== edgeCount ||
    routing.maximumX.length !== edgeCount ||
    routing.maximumY.length !== edgeCount ||
    routing.edgeIndexesByMinimumX.length !== edgeCount ||
    routing.prefixMaximumX.length !== edgeCount
  ) {
    throw new Error(
      'Full-network routing identity or array lengths are invalid',
    );
  }
  validateViewport(routing.bounds);
  const seenEdges = new Uint8Array(edgeCount);
  let previousMinimumX = Number.NEGATIVE_INFINITY;
  let runningMaximumX = Number.NEGATIVE_INFINITY;
  let overallMinimumX = Number.POSITIVE_INFINITY;
  let overallMinimumY = Number.POSITIVE_INFINITY;
  let overallMaximumX = Number.NEGATIVE_INFINITY;
  let overallMaximumY = Number.NEGATIVE_INFINITY;
  for (let position = 0; position < edgeCount; position += 1) {
    const edge = typedValue(
      routing.edgeIndexesByMinimumX,
      position,
      'sorted route edge',
    );
    if (edge >= edgeCount || seenEdges[edge] === 1) {
      throw new Error('Full-network routing index is not an edge permutation');
    }
    seenEdges[edge] = 1;
    const minX = finite(
      typedValue(routing.minimumX, edge, 'route minimum x'),
      'route minimum x',
    );
    const minY = finite(
      typedValue(routing.minimumY, edge, 'route minimum y'),
      'route minimum y',
    );
    const maxX = finite(
      typedValue(routing.maximumX, edge, 'route maximum x'),
      'route maximum x',
    );
    const maxY = finite(
      typedValue(routing.maximumY, edge, 'route maximum y'),
      'route maximum y',
    );
    if (minX > maxX || minY > maxY || minX < previousMinimumX) {
      throw new Error('Full-network routing index bounds are invalid');
    }
    previousMinimumX = minX;
    overallMinimumX = Math.min(overallMinimumX, minX);
    overallMinimumY = Math.min(overallMinimumY, minY);
    overallMaximumX = Math.max(overallMaximumX, maxX);
    overallMaximumY = Math.max(overallMaximumY, maxY);
    runningMaximumX = Math.max(runningMaximumX, maxX);
    if (
      typedValue(routing.prefixMaximumX, position, 'prefix maximum x') !==
      runningMaximumX
    ) {
      throw new Error('Full-network routing prefix index is invalid');
    }
  }
  const expectedBounds =
    edgeCount === 0
      ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : {
          minX: overallMinimumX,
          minY: overallMinimumY,
          maxX: overallMaximumX,
          maxY: overallMaximumY,
        };
  if (
    routing.bounds.minX !== expectedBounds.minX ||
    routing.bounds.minY !== expectedBounds.minY ||
    routing.bounds.maxX !== expectedBounds.maxX ||
    routing.bounds.maxY !== expectedBounds.maxY
  ) {
    throw new Error('Full-network routing aggregate bounds are invalid');
  }
  if (edgeCount > maximumNodes * 116) {
    throw new Error('Full-network routing exceeds its approved edge envelope');
  }
}
