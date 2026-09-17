export type ConnectionsPoint = Readonly<{
  x: number;
  y: number;
}>;

export type ConnectionsViewportGeometry = Readonly<{
  width: number;
  height: number;
}>;

export type ConnectionsNodeGeometry = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ConnectionsViewportPadding = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type ConnectionsCamera = Readonly<{
  x: number;
  y: number;
  scale: number;
}>;

export type ConnectionsCameraLimits = Readonly<{
  minimumScale: number;
  maximumScale: number;
  maximumFitScale: number;
}>;

export type ConnectionsCameraGeometry = Readonly<{
  viewport: ConnectionsViewportGeometry;
  world: ConnectionsNodeGeometry;
  padding: ConnectionsViewportPadding;
  limits: ConnectionsCameraLimits;
}>;

export const DEFAULT_CONNECTIONS_CAMERA_LIMITS: ConnectionsCameraLimits = {
  minimumScale: 0.1,
  maximumScale: 2,
  maximumFitScale: 1,
};

const epsilon = 1e-7;

export type ConnectionsCameraZoomState = Readonly<{
  percentLabel: string;
  zoomInDisabled: boolean;
  zoomOutDisabled: boolean;
}>;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function finitePoint(point: ConnectionsPoint): boolean {
  return finite(point.x) && finite(point.y);
}

function finiteRect(rect: ConnectionsNodeGeometry): boolean {
  return (
    finite(rect.x) &&
    finite(rect.y) &&
    finite(rect.width) &&
    finite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function finiteCamera(camera: ConnectionsCamera): boolean {
  return (
    finite(camera.x) &&
    finite(camera.y) &&
    finite(camera.scale) &&
    camera.scale > 0
  );
}

export function connectionsCameraZoomState(
  camera: ConnectionsCamera,
  limits: ConnectionsCameraLimits,
): ConnectionsCameraZoomState | null {
  if (
    !finiteCamera(camera) ||
    !finite(limits.minimumScale) ||
    !finite(limits.maximumScale) ||
    limits.minimumScale <= 0 ||
    limits.maximumScale < limits.minimumScale
  ) {
    return null;
  }
  const scale = clamp(camera.scale, limits.minimumScale, limits.maximumScale);
  const percent = scale * 100;
  const percentLabel =
    percent >= 1
      ? String(Math.round(percent))
      : percent >= 0.01
        ? String(Number(percent.toPrecision(2)))
        : '<0.01';
  const minimumTolerance = Math.max(
    Number.EPSILON * 32,
    Math.abs(limits.minimumScale) * 1e-6,
  );
  const maximumTolerance = Math.max(
    Number.EPSILON * 32,
    Math.abs(limits.maximumScale) * 1e-6,
  );
  return {
    percentLabel,
    zoomInDisabled: scale >= limits.maximumScale - maximumTolerance,
    zoomOutDisabled: scale <= limits.minimumScale + minimumTolerance,
  };
}

export function decodeConnectionsCameraScaleValue(
  value: unknown,
): number | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return finite(candidate) && candidate > 0 ? candidate : null;
}

export function decodeConnectionsCameraScale(
  value: unknown,
  limits: ConnectionsCameraLimits,
): number | null {
  const candidate = decodeConnectionsCameraScaleValue(value);
  if (
    candidate === null ||
    !finite(limits.minimumScale) ||
    !finite(limits.maximumScale) ||
    limits.minimumScale <= 0 ||
    limits.maximumScale < limits.minimumScale
  ) {
    return null;
  }
  return clamp(candidate, limits.minimumScale, limits.maximumScale);
}

function usableViewport(geometry: ConnectionsCameraGeometry) {
  const { viewport, padding, limits, world } = geometry;
  if (
    !finite(viewport.width) ||
    !finite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !finiteRect(world) ||
    ![padding.top, padding.right, padding.bottom, padding.left].every(
      (value) => finite(value) && value >= 0,
    ) ||
    !finite(limits.minimumScale) ||
    !finite(limits.maximumScale) ||
    !finite(limits.maximumFitScale) ||
    limits.minimumScale <= 0 ||
    limits.maximumScale < limits.minimumScale ||
    limits.maximumFitScale < limits.minimumScale
  ) {
    return null;
  }
  const width = viewport.width - padding.left - padding.right;
  const height = viewport.height - padding.top - padding.bottom;
  if (width <= 0 || height <= 0) return null;
  return {
    left: padding.left,
    right: viewport.width - padding.right,
    top: padding.top,
    bottom: viewport.height - padding.bottom,
    width,
    height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveConnectionsCameraLimits(
  viewport: ConnectionsViewportGeometry,
  world: ConnectionsNodeGeometry,
  padding: ConnectionsViewportPadding,
): ConnectionsCameraLimits | null {
  if (
    !finite(viewport.width) ||
    !finite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !finiteRect(world) ||
    ![padding.top, padding.right, padding.bottom, padding.left].every(
      (value) => finite(value) && value >= 0,
    )
  ) {
    return null;
  }
  const usableWidth = viewport.width - padding.left - padding.right;
  const usableHeight = viewport.height - padding.top - padding.bottom;
  if (usableWidth <= 0 || usableHeight <= 0) return null;
  const fitScale = Math.min(
    usableWidth / world.width,
    usableHeight / world.height,
    1,
  );
  if (!finite(fitScale) || fitScale <= 0) return null;
  return {
    minimumScale: Math.min(0.1, fitScale / 2),
    maximumScale: 2,
    maximumFitScale: 1,
  };
}

export function clampConnectionsCamera(
  camera: ConnectionsCamera,
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  if (!usableViewport(geometry) || !finiteCamera(camera)) return null;
  const scale = clamp(
    camera.scale,
    geometry.limits.minimumScale,
    geometry.limits.maximumScale,
  );
  return {
    x: camera.x,
    y: camera.y,
    scale,
  };
}

export function fitConnectionsCamera(
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  const viewport = usableViewport(geometry);
  if (!viewport) return null;
  const scale = clamp(
    Math.min(
      viewport.width / geometry.world.width,
      viewport.height / geometry.world.height,
      geometry.limits.maximumFitScale,
    ),
    geometry.limits.minimumScale,
    geometry.limits.maximumScale,
  );
  return clampConnectionsCamera(
    {
      x:
        viewport.left +
        (viewport.width - geometry.world.width * scale) / 2 -
        geometry.world.x * scale,
      y:
        viewport.top +
        (viewport.height - geometry.world.height * scale) / 2 -
        geometry.world.y * scale,
      scale,
    },
    geometry,
  );
}

function visibleViewport(
  geometry: ConnectionsCameraGeometry,
  screenMargin: number,
) {
  const viewport = usableViewport(geometry);
  if (!viewport || !finite(screenMargin) || screenMargin < 0) return null;
  const left = viewport.left + screenMargin;
  const right = viewport.right - screenMargin;
  const top = viewport.top + screenMargin;
  const bottom = viewport.bottom - screenMargin;
  if (left >= right || top >= bottom) return null;
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function screenRect(
  camera: ConnectionsCamera,
  target: ConnectionsNodeGeometry,
) {
  return {
    left: camera.x + target.x * camera.scale,
    right: camera.x + (target.x + target.width) * camera.scale,
    top: camera.y + target.y * camera.scale,
    bottom: camera.y + (target.y + target.height) * camera.scale,
    width: target.width * camera.scale,
    height: target.height * camera.scale,
  };
}

export function connectionsCameraContainsRect(
  camera: ConnectionsCamera,
  target: ConnectionsNodeGeometry,
  geometry: ConnectionsCameraGeometry,
  screenMargin = 0,
): boolean {
  const viewport = visibleViewport(geometry, screenMargin);
  if (
    !viewport ||
    !finiteCamera(camera) ||
    !finiteRect(target) ||
    target.width * camera.scale > viewport.width + epsilon ||
    target.height * camera.scale > viewport.height + epsilon
  ) {
    return false;
  }
  const rendered = screenRect(camera, target);
  return (
    rendered.left >= viewport.left - epsilon &&
    rendered.right <= viewport.right + epsilon &&
    rendered.top >= viewport.top - epsilon &&
    rendered.bottom <= viewport.bottom + epsilon
  );
}

export function centerConnectionsCameraOnRect(
  camera: ConnectionsCamera,
  target: ConnectionsNodeGeometry,
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  const viewport = usableViewport(geometry);
  if (!viewport || !finiteCamera(camera) || !finiteRect(target)) return null;
  return clampConnectionsCamera(
    {
      x:
        viewport.left +
        viewport.width / 2 -
        (target.x + target.width / 2) * camera.scale,
      y:
        viewport.top +
        viewport.height / 2 -
        (target.y + target.height / 2) * camera.scale,
      scale: camera.scale,
    },
    geometry,
  );
}

export function ensureConnectionsRectVisible(
  camera: ConnectionsCamera,
  target: ConnectionsNodeGeometry,
  geometry: ConnectionsCameraGeometry,
  screenMargin = 12,
): ConnectionsCamera | null {
  const viewport = visibleViewport(geometry, screenMargin);
  if (!viewport || !finiteCamera(camera) || !finiteRect(target)) return null;
  const rendered = screenRect(camera, target);
  if (rendered.width > viewport.width || rendered.height > viewport.height) {
    const scale = clamp(
      Math.min(
        camera.scale,
        viewport.width / target.width,
        viewport.height / target.height,
      ),
      geometry.limits.minimumScale,
      geometry.limits.maximumScale,
    );
    return centerConnectionsCameraOnRect(
      { x: camera.x, y: camera.y, scale },
      target,
      geometry,
    );
  }
  let x = camera.x;
  let y = camera.y;
  if (rendered.left < viewport.left) x += viewport.left - rendered.left;
  if (rendered.right > viewport.right) x -= rendered.right - viewport.right;
  if (rendered.top < viewport.top) y += viewport.top - rendered.top;
  if (rendered.bottom > viewport.bottom) y -= rendered.bottom - viewport.bottom;
  return clampConnectionsCamera({ x, y, scale: camera.scale }, geometry);
}

export function initialConnectionsCamera(
  geometry: ConnectionsCameraGeometry,
  currentNode: ConnectionsNodeGeometry | null,
  preferredScale: unknown = null,
): ConnectionsCamera | null {
  const camera = fitConnectionsCamera(geometry);
  if (!camera) return null;
  const decodedScale = decodeConnectionsCameraScale(
    preferredScale,
    geometry.limits,
  );
  if (decodedScale !== null) {
    return restoreConnectionsCameraScale(
      camera,
      decodedScale,
      geometry,
      currentNode,
    );
  }
  if (
    currentNode &&
    !connectionsCameraContainsRect(camera, currentNode, geometry, 12)
  ) {
    return ensureConnectionsRectVisible(camera, currentNode, geometry, 12);
  }
  return camera;
}

export function restoreConnectionsCameraScale(
  camera: ConnectionsCamera,
  preferredScale: unknown,
  geometry: ConnectionsCameraGeometry,
  currentNode: ConnectionsNodeGeometry | null,
): ConnectionsCamera | null {
  const viewport = usableViewport(geometry);
  const scale = decodeConnectionsCameraScale(preferredScale, geometry.limits);
  if (!viewport || !finiteCamera(camera) || scale === null) return null;
  const center = {
    x: viewport.left + viewport.width / 2,
    y: viewport.top + viewport.height / 2,
  };
  const restored = zoomConnectionsCamera(
    camera,
    scale / camera.scale,
    center,
    geometry,
  );
  if (
    !restored ||
    !currentNode ||
    connectionsCameraContainsRect(restored, currentNode, geometry, 12)
  ) {
    return restored;
  }
  return centerConnectionsCameraOnRect(restored, currentNode, geometry);
}

export function panConnectionsCamera(
  camera: ConnectionsCamera,
  delta: ConnectionsPoint,
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  if (!finitePoint(delta)) return null;
  return clampConnectionsCamera(
    { x: camera.x + delta.x, y: camera.y + delta.y, scale: camera.scale },
    geometry,
  );
}

export function connectionsCameraWorldPoint(
  camera: ConnectionsCamera,
  viewportPoint: ConnectionsPoint,
): ConnectionsPoint | null {
  if (!finiteCamera(camera) || !finitePoint(viewportPoint)) return null;
  return {
    x: (viewportPoint.x - camera.x) / camera.scale,
    y: (viewportPoint.y - camera.y) / camera.scale,
  };
}

export function zoomConnectionsCamera(
  camera: ConnectionsCamera,
  factor: number,
  anchor: ConnectionsPoint,
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  if (!finite(factor) || factor <= 0 || !finitePoint(anchor)) return null;
  const worldAnchor = connectionsCameraWorldPoint(camera, anchor);
  if (!worldAnchor) return null;
  const scale = clamp(
    camera.scale * factor,
    geometry.limits.minimumScale,
    geometry.limits.maximumScale,
  );
  return clampConnectionsCamera(
    {
      x: anchor.x - worldAnchor.x * scale,
      y: anchor.y - worldAnchor.y * scale,
      scale,
    },
    geometry,
  );
}

export function pinchConnectionsCamera(
  camera: ConnectionsCamera,
  start: readonly [ConnectionsPoint, ConnectionsPoint],
  current: readonly [ConnectionsPoint, ConnectionsPoint],
  geometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  if (![...start, ...current].every(finitePoint)) return null;
  const startDistance = Math.hypot(
    start[1].x - start[0].x,
    start[1].y - start[0].y,
  );
  const currentDistance = Math.hypot(
    current[1].x - current[0].x,
    current[1].y - current[0].y,
  );
  if (startDistance < epsilon || currentDistance < epsilon) {
    return clampConnectionsCamera(camera, geometry);
  }
  const startMidpoint = {
    x: (start[0].x + start[1].x) / 2,
    y: (start[0].y + start[1].y) / 2,
  };
  const currentMidpoint = {
    x: (current[0].x + current[1].x) / 2,
    y: (current[0].y + current[1].y) / 2,
  };
  const worldAnchor = connectionsCameraWorldPoint(camera, startMidpoint);
  if (!worldAnchor) return null;
  const scale = clamp(
    camera.scale * (currentDistance / startDistance),
    geometry.limits.minimumScale,
    geometry.limits.maximumScale,
  );
  return clampConnectionsCamera(
    {
      x: currentMidpoint.x - worldAnchor.x * scale,
      y: currentMidpoint.y - worldAnchor.y * scale,
      scale,
    },
    geometry,
  );
}

export function resizeConnectionsCamera(
  camera: ConnectionsCamera,
  previousGeometry: ConnectionsCameraGeometry,
  nextGeometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  const previousViewport = usableViewport(previousGeometry);
  const nextViewport = usableViewport(nextGeometry);
  if (!previousViewport || !nextViewport || !finiteCamera(camera)) {
    return fitConnectionsCamera(nextGeometry);
  }
  const previousCenter = {
    x: previousViewport.left + previousViewport.width / 2,
    y: previousViewport.top + previousViewport.height / 2,
  };
  const worldCenter = connectionsCameraWorldPoint(camera, previousCenter);
  if (!worldCenter) return fitConnectionsCamera(nextGeometry);
  const nextCenter = {
    x: nextViewport.left + nextViewport.width / 2,
    y: nextViewport.top + nextViewport.height / 2,
  };
  return clampConnectionsCamera(
    {
      x: nextCenter.x - worldCenter.x * camera.scale,
      y: nextCenter.y - worldCenter.y * camera.scale,
      scale: camera.scale,
    },
    nextGeometry,
  );
}

export function preserveConnectionsRectAnchor(
  camera: ConnectionsCamera,
  previousTarget: ConnectionsNodeGeometry,
  nextTarget: ConnectionsNodeGeometry,
  nextGeometry: ConnectionsCameraGeometry,
): ConnectionsCamera | null {
  if (
    !finiteCamera(camera) ||
    !finiteRect(previousTarget) ||
    !finiteRect(nextTarget)
  ) {
    return null;
  }
  const screenCenter = {
    x: camera.x + (previousTarget.x + previousTarget.width / 2) * camera.scale,
    y: camera.y + (previousTarget.y + previousTarget.height / 2) * camera.scale,
  };
  return clampConnectionsCamera(
    {
      x: screenCenter.x - (nextTarget.x + nextTarget.width / 2) * camera.scale,
      y: screenCenter.y - (nextTarget.y + nextTarget.height / 2) * camera.scale,
      scale: camera.scale,
    },
    nextGeometry,
  );
}

export function connectionsCameraTransform(
  camera: ConnectionsCamera,
): string | null {
  if (!finiteCamera(camera)) return null;
  return `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`;
}

export type ConnectionsCameraFrameAdapter = Readonly<{
  queue: (camera: ConnectionsCamera) => void;
  destroy: () => void;
}>;

export function createConnectionsCameraFrameAdapter(options: {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
  apply: (camera: ConnectionsCamera) => void;
}): ConnectionsCameraFrameAdapter {
  let pendingCamera: ConnectionsCamera | null = null;
  let frame: number | null = null;
  let destroyed = false;
  const flush = () => {
    frame = null;
    const camera = pendingCamera;
    pendingCamera = null;
    if (!destroyed && camera) options.apply(camera);
  };
  return {
    queue: (camera) => {
      if (destroyed) return;
      pendingCamera = { ...camera };
      frame ??= options.schedule(flush);
    },
    destroy: () => {
      destroyed = true;
      pendingCamera = null;
      if (frame !== null) options.cancel(frame);
      frame = null;
    },
  };
}
