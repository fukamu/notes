import type {
  ConnectionsLayoutSection,
  LayoutPoint,
} from '@/lib/graph/elk-layout';

export type ConnectionsPathOptions = Readonly<{
  maximumRadius: number;
  nodeClearance: number;
}>;

export type ConnectionsPathSegment =
  | Readonly<{
      kind: 'line';
      start: LayoutPoint;
      end: LayoutPoint;
    }>
  | Readonly<{
      kind: 'quadratic';
      start: LayoutPoint;
      control: LayoutPoint;
      end: LayoutPoint;
    }>;

export type ConnectionsSvgPath = Readonly<{
  d: string;
  startPoint: LayoutPoint;
  endPoint: LayoutPoint;
  segments: readonly ConnectionsPathSegment[];
  quadraticCount: number;
}>;

const epsilon = 1e-7;
const minimumCurveRadius = 0.05;

function finitePoint(point: LayoutPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function samePoint(left: LayoutPoint, right: LayoutPoint): boolean {
  return (
    Math.abs(left.x - right.x) < epsilon && Math.abs(left.y - right.y) < epsilon
  );
}

function cross(
  previous: LayoutPoint,
  point: LayoutPoint,
  next: LayoutPoint,
): number {
  return (
    (point.x - previous.x) * (next.y - point.y) -
    (point.y - previous.y) * (next.x - point.x)
  );
}

function isForwardCollinear(
  previous: LayoutPoint,
  point: LayoutPoint,
  next: LayoutPoint,
): boolean {
  if (Math.abs(cross(previous, point, next)) >= epsilon) return false;
  return (
    (point.x - previous.x) * (next.x - point.x) +
      (point.y - previous.y) * (next.y - point.y) >=
    0
  );
}

export function normalizeConnectionsOrthogonalPoints(
  section: ConnectionsLayoutSection,
): LayoutPoint[] {
  const normalized: LayoutPoint[] = [];
  for (const point of [
    section.startPoint,
    ...section.bendPoints,
    section.endPoint,
  ]) {
    if (!finitePoint(point)) {
      throw new Error(
        `Connections section ${section.id} has a non-finite point`,
      );
    }
    const last = normalized.at(-1);
    if (last && samePoint(last, point)) continue;
    while (normalized.length >= 2) {
      const previous = normalized.at(-2);
      const middle = normalized.at(-1);
      if (
        !previous ||
        !middle ||
        !isForwardCollinear(previous, middle, point)
      ) {
        break;
      }
      normalized.pop();
    }
    normalized.push({ x: point.x, y: point.y });
  }
  if (normalized.length < 2) {
    throw new Error(`Connections section ${section.id} has no visible route`);
  }
  return normalized;
}

function distance(left: LayoutPoint, right: LayoutPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function pointToward(
  origin: LayoutPoint,
  target: LayoutPoint,
  amount: number,
): LayoutPoint {
  const length = distance(origin, target);
  if (length < epsilon) return { ...origin };
  const ratio = amount / length;
  return {
    x: origin.x + (target.x - origin.x) * ratio,
    y: origin.y + (target.y - origin.y) * ratio,
  };
}

function coordinate(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

function pointCommand(command: 'M' | 'L', point: LayoutPoint): string {
  return `${command} ${coordinate(point.x)} ${coordinate(point.y)}`;
}

function roundedCorner(
  previous: LayoutPoint,
  corner: LayoutPoint,
  next: LayoutPoint,
  options: ConnectionsPathOptions,
) {
  if (Math.abs(cross(previous, corner, next)) < epsilon) return null;
  const radius = Math.min(
    options.maximumRadius,
    options.nodeClearance / 2,
    distance(previous, corner) / 2,
    distance(corner, next) / 2,
  );
  if (radius < minimumCurveRadius) return null;
  return {
    entry: pointToward(corner, previous, radius),
    control: { ...corner },
    exit: pointToward(corner, next, radius),
  };
}

export function createConnectionsSvgPath(
  section: ConnectionsLayoutSection,
  options: ConnectionsPathOptions,
): ConnectionsSvgPath {
  if (
    !Number.isFinite(options.maximumRadius) ||
    options.maximumRadius < 0 ||
    !Number.isFinite(options.nodeClearance) ||
    options.nodeClearance < 0
  ) {
    throw new Error('Connections path radius and clearance must be finite');
  }
  const points = normalizeConnectionsOrthogonalPoints(section);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    throw new Error(`Connections section ${section.id} has no endpoints`);
  }
  const commands = [pointCommand('M', first)];
  const segments: ConnectionsPathSegment[] = [];
  let cursor = first;
  let quadraticCount = 0;

  const addLine = (end: LayoutPoint) => {
    if (samePoint(cursor, end)) return;
    commands.push(pointCommand('L', end));
    segments.push({ kind: 'line', start: { ...cursor }, end: { ...end } });
    cursor = end;
  };

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    if (!previous || !corner || !next) {
      throw new Error(`Connections section ${section.id} is discontinuous`);
    }
    const rounded = roundedCorner(previous, corner, next, options);
    if (!rounded) {
      addLine(corner);
      continue;
    }
    addLine(rounded.entry);
    commands.push(
      `Q ${coordinate(rounded.control.x)} ${coordinate(rounded.control.y)} ${coordinate(rounded.exit.x)} ${coordinate(rounded.exit.y)}`,
    );
    segments.push({
      kind: 'quadratic',
      start: { ...cursor },
      control: rounded.control,
      end: rounded.exit,
    });
    cursor = rounded.exit;
    quadraticCount += 1;
  }
  addLine(last);
  if (segments.length === 0) {
    throw new Error(
      `Connections section ${section.id} has no visible segments`,
    );
  }
  return {
    d: commands.join(' '),
    startPoint: { ...first },
    endPoint: { ...last },
    segments,
    quadraticCount,
  };
}

function quadraticPoint(
  start: LayoutPoint,
  control: LayoutPoint,
  end: LayoutPoint,
  progress: number,
): LayoutPoint {
  const remaining = 1 - progress;
  return {
    x:
      remaining ** 2 * start.x +
      2 * remaining * progress * control.x +
      progress ** 2 * end.x,
    y:
      remaining ** 2 * start.y +
      2 * remaining * progress * control.y +
      progress ** 2 * end.y,
  };
}

export function sampleConnectionsSvgPath(
  path: ConnectionsSvgPath,
  curveSteps = 12,
): LayoutPoint[] {
  if (!Number.isSafeInteger(curveSteps) || curveSteps <= 0) {
    throw new Error('Connections path sampling steps must be positive');
  }
  const points = [{ ...path.startPoint }];
  for (const segment of path.segments) {
    if (segment.kind === 'line') {
      points.push({ ...segment.end });
      continue;
    }
    for (let step = 1; step <= curveSteps; step += 1) {
      points.push(
        quadraticPoint(
          segment.start,
          segment.control,
          segment.end,
          step / curveSteps,
        ),
      );
    }
  }
  return points;
}
