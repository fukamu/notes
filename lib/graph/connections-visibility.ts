import {
  createConnectionsSvgPath,
  type ConnectionsPathOptions,
} from '@/lib/graph/connections-path';
import type {
  ConnectionsLayoutSection,
  LayoutPoint,
} from '@/lib/graph/elk-layout';
import type {
  ConnectionsCamera,
  ConnectionsNodeGeometry,
  ConnectionsViewportGeometry,
} from '@/lib/graph/connections-viewport';

export type ConnectionsBounds = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type PreparedConnectionsSection = Readonly<{
  sectionId: string;
  d: string;
  bounds: ConnectionsBounds;
  hasEndArrow: boolean;
}>;

export type PreparedConnectionsEdge = Readonly<{
  id: string;
  edgeIndex: number;
  sections: readonly PreparedConnectionsSection[];
  bounds: ConnectionsBounds;
}>;

export type ConnectionsVisibilitySelection = Readonly<{
  nodeIndices: readonly number[];
  edgeIndices: readonly number[];
}>;

type VisibilityNode = ConnectionsNodeGeometry;

type VisibilityEdge = Readonly<{
  id: string;
  sections: readonly ConnectionsLayoutSection[];
}>;

type IndexedBounds = Readonly<{
  itemIndex: number;
  bounds: ConnectionsBounds;
}>;

type BoundsIndex =
  | Readonly<{
      kind: 'leaf';
      bounds: ConnectionsBounds;
      entries: readonly IndexedBounds[];
    }>
  | Readonly<{
      kind: 'branch';
      bounds: ConnectionsBounds;
      before: BoundsIndex;
      after: BoundsIndex;
    }>;

export type PreparedConnectionsVisibility = Readonly<{
  worldBounds: ConnectionsNodeGeometry;
  nodeBounds: readonly ConnectionsBounds[];
  edges: readonly PreparedConnectionsEdge[];
  nodeIndex: BoundsIndex | null;
  segmentIndex: BoundsIndex | null;
}>;

export const CONNECTIONS_VISIBILITY_OVERSCAN_PX = 96;
const nodeVisualMargin = 8;
// The 8px halo has a 4px half-width. The SVG marker is 7 stroke-width units
// at a 2px stroke, so 14 world units conservatively covers its full extent.
const edgeVisualMargin = 14;
const maximumLeafSize = 8;

function finiteBounds(bounds: ConnectionsBounds): boolean {
  return (
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.bottom) &&
    bounds.right >= bounds.left &&
    bounds.bottom >= bounds.top
  );
}

function pointBounds(...points: readonly LayoutPoint[]): ConnectionsBounds {
  const first = points[0];
  if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.y)) {
    throw new Error('Connections visibility requires finite path points');
  }
  let left = first.x;
  let right = first.x;
  let top = first.y;
  let bottom = first.y;
  for (const point of points.slice(1)) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Connections visibility requires finite path points');
    }
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { left, top, right, bottom };
}

function expandBounds(
  bounds: ConnectionsBounds,
  amount: number,
): ConnectionsBounds {
  return {
    left: bounds.left - amount,
    top: bounds.top - amount,
    right: bounds.right + amount,
    bottom: bounds.bottom + amount,
  };
}

function unionBounds(
  left: ConnectionsBounds,
  right: ConnectionsBounds,
): ConnectionsBounds {
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

function unionAll(entries: readonly IndexedBounds[]): ConnectionsBounds {
  const first = entries[0];
  if (!first) throw new Error('Cannot index empty connections bounds');
  return entries
    .slice(1)
    .reduce((bounds, entry) => unionBounds(bounds, entry.bounds), first.bounds);
}

function center(bounds: ConnectionsBounds, axis: 'x' | 'y'): number {
  return axis === 'x'
    ? (bounds.left + bounds.right) / 2
    : (bounds.top + bounds.bottom) / 2;
}

function createBoundsIndex(
  entries: readonly IndexedBounds[],
): BoundsIndex | null {
  if (entries.length === 0) return null;
  const bounds = unionAll(entries);
  if (entries.length <= maximumLeafSize) {
    return { kind: 'leaf', bounds, entries: [...entries] };
  }
  const axis =
    bounds.right - bounds.left >= bounds.bottom - bounds.top ? 'x' : 'y';
  const ordered = [...entries].sort(
    (left, right) =>
      center(left.bounds, axis) - center(right.bounds, axis) ||
      left.itemIndex - right.itemIndex,
  );
  const middle = Math.floor(ordered.length / 2);
  const before = createBoundsIndex(ordered.slice(0, middle));
  const after = createBoundsIndex(ordered.slice(middle));
  if (!before || !after) {
    throw new Error('Connections visibility index split was empty');
  }
  return { kind: 'branch', bounds, before, after };
}

function intersects(
  left: ConnectionsBounds,
  right: ConnectionsBounds,
): boolean {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function queryBoundsIndex(
  index: BoundsIndex | null,
  query: ConnectionsBounds,
): Set<number> {
  const matches = new Set<number>();
  if (!index) return matches;
  const pending: BoundsIndex[] = [index];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !intersects(current.bounds, query)) continue;
    if (current.kind === 'branch') {
      pending.push(current.after, current.before);
      continue;
    }
    for (const entry of current.entries) {
      if (intersects(entry.bounds, query)) matches.add(entry.itemIndex);
    }
  }
  return matches;
}

function rectBounds(rect: ConnectionsNodeGeometry): ConnectionsBounds {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error('Connections visibility requires finite positive bounds');
  }
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

export function prepareConnectionsVisibility(
  nodes: readonly VisibilityNode[],
  edges: readonly VisibilityEdge[],
  world: ConnectionsNodeGeometry,
  pathOptions: ConnectionsPathOptions,
): PreparedConnectionsVisibility {
  const worldLayoutBounds = rectBounds(world);
  const nodeBounds = nodes.map((node) =>
    expandBounds(rectBounds(node), nodeVisualMargin),
  );
  const segmentEntries: IndexedBounds[] = [];
  const preparedEdges = edges.map(
    (edge, edgeIndex): PreparedConnectionsEdge => {
      const sections = edge.sections.map((section, sectionIndex) => {
        const path = createConnectionsSvgPath(section, pathOptions);
        let sectionBounds: ConnectionsBounds | null = null;
        for (const segment of path.segments) {
          const raw =
            segment.kind === 'line'
              ? pointBounds(segment.start, segment.end)
              : pointBounds(segment.start, segment.control, segment.end);
          const bounds = expandBounds(raw, edgeVisualMargin);
          sectionBounds = sectionBounds
            ? unionBounds(sectionBounds, bounds)
            : bounds;
          segmentEntries.push({ itemIndex: edgeIndex, bounds });
        }
        if (!sectionBounds) {
          throw new Error(`Connections edge ${edge.id} has an empty section`);
        }
        return {
          sectionId: section.id,
          d: path.d,
          bounds: sectionBounds,
          hasEndArrow: sectionIndex === edge.sections.length - 1,
        };
      });
      const first = sections[0];
      if (!first)
        throw new Error(`Connections edge ${edge.id} has no sections`);
      const bounds = sections
        .slice(1)
        .reduce(
          (combined, section) => unionBounds(combined, section.bounds),
          first.bounds,
        );
      return { id: edge.id, edgeIndex, sections, bounds };
    },
  );
  const geometryBounds = [
    ...nodeBounds,
    ...preparedEdges.map((edge) => edge.bounds),
  ]
    .filter(finiteBounds)
    .reduce(unionBounds, worldLayoutBounds);
  const worldBounds = {
    x: geometryBounds.left,
    y: geometryBounds.top,
    width: geometryBounds.right - geometryBounds.left,
    height: geometryBounds.bottom - geometryBounds.top,
  };
  return {
    worldBounds,
    nodeBounds,
    edges: preparedEdges,
    nodeIndex: createBoundsIndex(
      nodeBounds.map((bounds, itemIndex) => ({ itemIndex, bounds })),
    ),
    segmentIndex: createBoundsIndex(segmentEntries),
  };
}

export function queryConnectionsVisibility(
  prepared: PreparedConnectionsVisibility,
  camera: ConnectionsCamera,
  viewport: ConnectionsViewportGeometry,
  overscanPx = CONNECTIONS_VISIBILITY_OVERSCAN_PX,
): ConnectionsVisibilitySelection {
  if (
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.scale) ||
    camera.scale <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(overscanPx) ||
    overscanPx < 0
  ) {
    return { nodeIndices: [], edgeIndices: [] };
  }
  const query = {
    left: (-camera.x - overscanPx) / camera.scale,
    top: (-camera.y - overscanPx) / camera.scale,
    right: (viewport.width - camera.x + overscanPx) / camera.scale,
    bottom: (viewport.height - camera.y + overscanPx) / camera.scale,
  };
  return {
    nodeIndices: [...queryBoundsIndex(prepared.nodeIndex, query)].sort(
      (left, right) => left - right,
    ),
    edgeIndices: [...queryBoundsIndex(prepared.segmentIndex, query)].sort(
      (left, right) => left - right,
    ),
  };
}

export function sameConnectionsVisibility(
  left: ConnectionsVisibilitySelection,
  right: ConnectionsVisibilitySelection,
): boolean {
  return (
    left.nodeIndices.length === right.nodeIndices.length &&
    left.edgeIndices.length === right.edgeIndices.length &&
    left.nodeIndices.every(
      (value, index) => right.nodeIndices[index] === value,
    ) &&
    left.edgeIndices.every((value, index) => right.edgeIndices[index] === value)
  );
}
