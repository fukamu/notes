import type {
  ConnectionsLayout,
  ConnectionsLayoutEdge,
  ConnectionsLayoutNode,
  ConnectionsLayoutPort,
  ConnectionsLayoutSection,
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
  endpointMismatches: number;
  sectionDiscontinuities: number;
  nodeIntrusions: number;
  edgeCrossings: number;
  overlappingSegments: number;
  overlappingLength: number;
  totalRouteLength: number;
  bendOrControlPointCount: number;
  graphBoundingArea: number;
};

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
  node: ConnectionsLayoutNode,
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

function pointOnNodeBoundary(
  point: LayoutPoint,
  node: ConnectionsLayoutNode,
): boolean {
  const withinX =
    point.x >= node.x - epsilon && point.x <= node.x + node.width + epsilon;
  const withinY =
    point.y >= node.y - epsilon && point.y <= node.y + node.height + epsilon;
  const onVertical =
    Math.abs(point.x - node.x) < epsilon ||
    Math.abs(point.x - node.x - node.width) < epsilon;
  const onHorizontal =
    Math.abs(point.y - node.y) < epsilon ||
    Math.abs(point.y - node.y - node.height) < epsilon;
  return withinX && withinY && (onVertical || onHorizontal);
}

function pointOnPortAttachment(
  point: LayoutPoint,
  port: ConnectionsLayoutPort,
  endpoint: 'source' | 'target',
): boolean {
  const withinY =
    point.y >= port.y - epsilon && point.y <= port.y + port.height + epsilon;
  const expectedX = endpoint === 'source' ? port.x + port.width : port.x;
  return withinY && Math.abs(point.x - expectedX) < epsilon;
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
): RouteQuality {
  let nonFiniteValues = 0;
  let endpointMismatches = 0;
  let sectionDiscontinuities = 0;
  let nodeIntrusions = 0;
  let totalRouteLength = 0;
  let bendOrControlPointCount = 0;
  const segments: RouteSegment[] = [];
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
    if (
      !(sourcePort
        ? pointOnPortAttachment(firstSection.startPoint, sourcePort, 'source')
        : pointOnNodeBoundary(firstSection.startPoint, source))
    )
      endpointMismatches += 1;
    if (
      !(targetPort
        ? pointOnPortAttachment(lastSection.endPoint, targetPort, 'target')
        : pointOnNodeBoundary(lastSection.endPoint, target))
    )
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
    for (const polyline of geometry.polylines) {
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
        totalRouteLength += distance(start, end);
        segments.push({ edgeIndex, start, end });
        if (
          !edgeIntrudes &&
          otherNodes.some((node) =>
            segmentCrossesRectInterior(start, end, node),
          )
        ) {
          edgeIntrudes = true;
        }
      }
    }
    if (edgeIntrudes) nodeIntrusions += 1;
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

  return {
    nonFiniteValues,
    endpointMismatches,
    sectionDiscontinuities,
    nodeIntrusions,
    edgeCrossings,
    overlappingSegments,
    overlappingLength,
    totalRouteLength,
    bendOrControlPointCount,
    graphBoundingArea: layout.width * layout.height,
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
