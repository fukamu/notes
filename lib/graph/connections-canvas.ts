import type { LayoutPoint } from '@/lib/graph/elk-layout';
import type { ConnectionsPathSegment } from '@/lib/graph/connections-path';

export type ConnectionsCanvasArrow = Readonly<{
  tip: LayoutPoint;
  baseBefore: LayoutPoint;
  baseAfter: LayoutPoint;
}>;

export const CONNECTIONS_EDGE_HALO_WIDTH = 8;
export const CONNECTIONS_EDGE_STROKE_WIDTH = 2;
export const CONNECTIONS_EDGE_STROKE_OPACITY = 0.72;

// The previous SVG arrow used width/height 7 in 2-unit stroke coordinates. Its
// 0..10 viewBox therefore maps each arrow unit to 1.4 world units. refX=9
// places the triangle tip 1.4 units beyond the endpoint,
// with its base 12.6 units behind it and 7 units to either side.
const arrowTipOffset = 1.4;
const arrowBaseOffset = 12.6;
const arrowHalfWidth = 7;
const tangentEpsilon = 1e-7;

function terminalTangent(segment: ConnectionsPathSegment): Readonly<{
  from: LayoutPoint;
  to: LayoutPoint;
}> {
  return segment.kind === 'line'
    ? { from: segment.start, to: segment.end }
    : { from: segment.control, to: segment.end };
}

export function createConnectionsCanvasArrow(
  segment: ConnectionsPathSegment,
): ConnectionsCanvasArrow {
  const tangent = terminalTangent(segment);
  const deltaX = tangent.to.x - tangent.from.x;
  const deltaY = tangent.to.y - tangent.from.y;
  const length = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(length) || length < tangentEpsilon) {
    throw new Error('Connections arrow requires a finite terminal tangent');
  }
  const directionX = deltaX / length;
  const directionY = deltaY / length;
  const perpendicularX = -directionY;
  const perpendicularY = directionX;
  const baseCenter = {
    x: tangent.to.x - directionX * arrowBaseOffset,
    y: tangent.to.y - directionY * arrowBaseOffset,
  };
  return {
    tip: {
      x: tangent.to.x + directionX * arrowTipOffset,
      y: tangent.to.y + directionY * arrowTipOffset,
    },
    baseBefore: {
      x: baseCenter.x + perpendicularX * arrowHalfWidth,
      y: baseCenter.y + perpendicularY * arrowHalfWidth,
    },
    baseAfter: {
      x: baseCenter.x - perpendicularX * arrowHalfWidth,
      y: baseCenter.y - perpendicularY * arrowHalfWidth,
    },
  };
}
