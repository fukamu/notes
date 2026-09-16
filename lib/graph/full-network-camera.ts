import type { CardId } from '@/lib/domain/id';
import {
  createFullNetworkRenderPlan,
  defaultFullNetworkRenderConfiguration,
  fitFullNetworkRenderCamera,
  queryFullNetworkNodes,
  type FullNetworkRenderCamera,
  type FullNetworkRenderDataset,
  type FullNetworkSemanticLevel,
} from '@/lib/graph/full-network-render-plan';

export type FullNetworkScreenPoint = Readonly<{ x: number; y: number }>;

export type FullNetworkCameraRestoreReason = 'exact' | 'anchor' | 'fit';

export type FullNetworkMapSnapshot = Readonly<{
  version: 1;
  topologyKey: string;
  layoutKey: string;
  camera: FullNetworkRenderCamera;
  selectedCardId: CardId | null;
  anchor: Readonly<{
    cardId: CardId;
    viewportXRatio: number;
    viewportYRatio: number;
  }> | null;
}>;

export type FullNetworkCameraRestore = Readonly<{
  camera: FullNetworkRenderCamera;
  selectedCardId: CardId | null;
  reason: FullNetworkCameraRestoreReason;
}>;

export type FullNetworkNodeActivation = Readonly<{
  camera: FullNetworkRenderCamera;
  selectedCardId: CardId | null;
  command:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'open-card'; cardId: CardId }>;
}>;

export const defaultFullNetworkCameraConfiguration = {
  paddingPixels: 12,
  maximumScale: 8,
  minimumHitRadiusPixels: 14,
  keyboardPanPixels: 64,
  zoomStep: 1.25,
} as const;

type CameraConfiguration = typeof defaultFullNetworkCameraConfiguration;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function typedValue(
  values: Uint32Array | Float32Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function configuration(
  candidate?: Partial<CameraConfiguration>,
): CameraConfiguration {
  const value = {
    ...defaultFullNetworkCameraConfiguration,
    ...candidate,
  };
  if (
    !Number.isFinite(value.paddingPixels) ||
    value.paddingPixels < 0 ||
    !Number.isFinite(value.maximumScale) ||
    value.maximumScale <= 0 ||
    !Number.isFinite(value.minimumHitRadiusPixels) ||
    value.minimumHitRadiusPixels < 0 ||
    !Number.isFinite(value.keyboardPanPixels) ||
    value.keyboardPanPixels <= 0 ||
    !Number.isFinite(value.zoomStep) ||
    value.zoomStep <= 1
  ) {
    throw new RangeError('Full-network camera configuration is invalid');
  }
  return value;
}

function minimumScale(
  dataset: FullNetworkRenderDataset,
  viewportWidth: number,
  viewportHeight: number,
  paddingPixels: number,
): number {
  return fitFullNetworkRenderCamera({
    dataset,
    viewportWidth,
    viewportHeight,
    paddingPixels,
  }).scale;
}

function clampTranslation(
  translation: number,
  worldSize: number,
  scale: number,
  viewportSize: number,
  padding: number,
): number {
  const available = Math.max(1, viewportSize - padding * 2);
  const scaled = worldSize * scale;
  if (scaled <= available) return (viewportSize - scaled) / 2;
  // Once zoomed, allow either world edge to reach the viewport center. This
  // keeps explicit “current location” and selected-node zoom meaningful for
  // cards at the outer edge without allowing the map to disappear entirely.
  return clamp(translation, viewportSize / 2 - scaled, viewportSize / 2);
}

export function clampFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  const options = configuration(candidate);
  positive(camera.viewportWidth, 'camera.viewportWidth');
  positive(camera.viewportHeight, 'camera.viewportHeight');
  positive(camera.scale, 'camera.scale');
  finite(camera.offsetX, 'camera.offsetX');
  finite(camera.offsetY, 'camera.offsetY');
  const fitScale = minimumScale(
    dataset,
    camera.viewportWidth,
    camera.viewportHeight,
    options.paddingPixels,
  );
  const scale = clamp(
    camera.scale,
    fitScale,
    Math.max(fitScale, options.maximumScale),
  );
  return {
    offsetX: clampTranslation(
      camera.offsetX,
      dataset.routing.layout.width,
      scale,
      camera.viewportWidth,
      options.paddingPixels,
    ),
    offsetY: clampTranslation(
      camera.offsetY,
      dataset.routing.layout.height,
      scale,
      camera.viewportHeight,
      options.paddingPixels,
    ),
    scale,
    viewportWidth: camera.viewportWidth,
    viewportHeight: camera.viewportHeight,
  };
}

export function fitFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  viewportWidth: number,
  viewportHeight: number,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  const options = configuration(candidate);
  return clampFullNetworkCamera(
    dataset,
    fitFullNetworkRenderCamera({
      dataset,
      viewportWidth,
      viewportHeight,
      paddingPixels: options.paddingPixels,
    }),
    options,
  );
}

export function panFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  delta: FullNetworkScreenPoint,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  finite(delta.x, 'delta.x');
  finite(delta.y, 'delta.y');
  return clampFullNetworkCamera(
    dataset,
    {
      ...camera,
      offsetX: camera.offsetX + delta.x,
      offsetY: camera.offsetY + delta.y,
    },
    candidate,
  );
}

export function fullNetworkWorldPoint(
  camera: FullNetworkRenderCamera,
  point: FullNetworkScreenPoint,
): FullNetworkScreenPoint {
  positive(camera.scale, 'camera.scale');
  finite(point.x, 'point.x');
  finite(point.y, 'point.y');
  return {
    x: (point.x - camera.offsetX) / camera.scale,
    y: (point.y - camera.offsetY) / camera.scale,
  };
}

export function zoomFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  factor: number,
  anchor: FullNetworkScreenPoint,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  positive(factor, 'factor');
  const world = fullNetworkWorldPoint(camera, anchor);
  return clampFullNetworkCamera(
    dataset,
    {
      ...camera,
      offsetX: anchor.x - world.x * camera.scale * factor,
      offsetY: anchor.y - world.y * camera.scale * factor,
      scale: camera.scale * factor,
    },
    candidate,
  );
}

export function pinchFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  start: readonly [FullNetworkScreenPoint, FullNetworkScreenPoint],
  current: readonly [FullNetworkScreenPoint, FullNetworkScreenPoint],
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  const startDistance = Math.hypot(
    start[1].x - start[0].x,
    start[1].y - start[0].y,
  );
  const currentDistance = Math.hypot(
    current[1].x - current[0].x,
    current[1].y - current[0].y,
  );
  if (startDistance <= 1e-7 || currentDistance <= 1e-7) {
    return clampFullNetworkCamera(dataset, camera, candidate);
  }
  const startMidpoint = {
    x: (start[0].x + start[1].x) / 2,
    y: (start[0].y + start[1].y) / 2,
  };
  const currentMidpoint = {
    x: (current[0].x + current[1].x) / 2,
    y: (current[0].y + current[1].y) / 2,
  };
  const world = fullNetworkWorldPoint(camera, startMidpoint);
  const scale = camera.scale * (currentDistance / startDistance);
  return clampFullNetworkCamera(
    dataset,
    {
      ...camera,
      offsetX: currentMidpoint.x - world.x * scale,
      offsetY: currentMidpoint.y - world.y * scale,
      scale,
    },
    candidate,
  );
}

export function resizeFullNetworkCamera(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  viewportWidth: number,
  viewportHeight: number,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera {
  positive(viewportWidth, 'viewportWidth');
  positive(viewportHeight, 'viewportHeight');
  const oldCenter = fullNetworkWorldPoint(camera, {
    x: camera.viewportWidth / 2,
    y: camera.viewportHeight / 2,
  });
  return clampFullNetworkCamera(
    dataset,
    {
      offsetX: viewportWidth / 2 - oldCenter.x * camera.scale,
      offsetY: viewportHeight / 2 - oldCenter.y * camera.scale,
      scale: camera.scale,
      viewportWidth,
      viewportHeight,
    },
    candidate,
  );
}

function nodePoint(
  dataset: FullNetworkRenderDataset,
  nodeIndex: number,
): FullNetworkScreenPoint {
  return {
    x: typedValue(dataset.routing.layout.x, nodeIndex, 'node x'),
    y: typedValue(dataset.routing.layout.y, nodeIndex, 'node y'),
  };
}

function nodeCardId(
  dataset: FullNetworkRenderDataset,
  nodeIndex: number,
): CardId {
  const value = dataset.routing.topology.nodeIds[nodeIndex];
  if (!value) throw new Error(`Missing node identity at ${nodeIndex}`);
  return value;
}

export function centerFullNetworkCameraOnCard(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  cardId: CardId,
  candidate?: Partial<CameraConfiguration>,
): FullNetworkRenderCamera | null {
  const nodeIndex = dataset.nodeIndexesByCardId.get(cardId);
  if (nodeIndex === undefined) return null;
  const options = configuration(candidate);
  const point = nodePoint(dataset, nodeIndex);
  const availableWidth = Math.max(
    1,
    camera.viewportWidth - options.paddingPixels * 2,
  );
  const availableHeight = Math.max(
    1,
    camera.viewportHeight - options.paddingPixels * 2,
  );
  const nodeDiameter =
    Math.min(
      dataset.routing.routingConfiguration.nodeHalfWidth,
      dataset.routing.routingConfiguration.nodeHalfHeight,
    ) * 2;
  const centeringScale = Math.max(
    camera.scale,
    (availableWidth / Math.max(1, dataset.routing.layout.width)) * 1.01,
    (availableHeight / Math.max(1, dataset.routing.layout.height)) * 1.01,
    defaultFullNetworkRenderConfiguration.overviewToNetworkPixels /
      nodeDiameter,
  );
  return clampFullNetworkCamera(
    dataset,
    {
      ...camera,
      offsetX: camera.viewportWidth / 2 - point.x * centeringScale,
      offsetY: camera.viewportHeight / 2 - point.y * centeringScale,
      scale: centeringScale,
    },
    options,
  );
}

export function hitTestFullNetworkNode(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  screenPoint: FullNetworkScreenPoint,
  candidate?: Partial<CameraConfiguration>,
): CardId | null {
  const options = configuration(candidate);
  const world = fullNetworkWorldPoint(camera, screenPoint);
  const worldRadius = options.minimumHitRadiusPixels / camera.scale;
  const halfWidth = dataset.routing.routingConfiguration.nodeHalfWidth;
  const halfHeight = dataset.routing.routingConfiguration.nodeHalfHeight;
  const candidates = queryFullNetworkNodes(dataset, {
    minX: world.x - worldRadius - halfWidth,
    minY: world.y - worldRadius - halfHeight,
    maxX: world.x + worldRadius + halfWidth,
    maxY: world.y + worldRadius + halfHeight,
  });
  let match: Readonly<{ nodeIndex: number; distance: number }> | null = null;
  for (const nodeIndex of candidates) {
    const point = nodePoint(dataset, nodeIndex);
    const dx = (point.x - world.x) * camera.scale;
    const dy = (point.y - world.y) * camera.scale;
    const distance = Math.hypot(dx, dy);
    const nodeRadius = Math.max(
      halfWidth * camera.scale,
      halfHeight * camera.scale,
      options.minimumHitRadiusPixels,
    );
    if (
      distance <= nodeRadius &&
      (!match ||
        distance < match.distance ||
        (distance === match.distance && nodeIndex < match.nodeIndex))
    ) {
      match = { nodeIndex, distance };
    }
  }
  return match ? nodeCardId(dataset, match.nodeIndex) : null;
}

function semanticLevel(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  previousLevel?: FullNetworkSemanticLevel,
): FullNetworkSemanticLevel {
  return createFullNetworkRenderPlan({
    dataset,
    camera,
    ...(previousLevel ? { previousLevel } : {}),
    reducedMotion: true,
  }).level;
}

function zoomScaleForNextLevel(
  dataset: FullNetworkRenderDataset,
  currentScale: number,
  level: Exclude<FullNetworkSemanticLevel, 'detail'>,
): number {
  const nodeDiameter =
    Math.min(
      dataset.routing.routingConfiguration.nodeHalfWidth,
      dataset.routing.routingConfiguration.nodeHalfHeight,
    ) * 2;
  const threshold =
    level === 'overview'
      ? defaultFullNetworkRenderConfiguration.overviewToNetworkPixels
      : defaultFullNetworkRenderConfiguration.networkToDetailPixels;
  return Math.max(currentScale * 1.5, threshold / nodeDiameter);
}

export function activateFullNetworkNode(
  input: Readonly<{
    dataset: FullNetworkRenderDataset;
    camera: FullNetworkRenderCamera;
    cardId: CardId;
    level: FullNetworkSemanticLevel;
    configuration?: Partial<CameraConfiguration>;
  }>,
): FullNetworkNodeActivation {
  if (!input.dataset.nodeIndexesByCardId.has(input.cardId)) {
    return {
      camera: input.camera,
      selectedCardId: null,
      command: { kind: 'none' },
    };
  }
  if (input.level === 'detail') {
    return {
      camera: input.camera,
      selectedCardId: input.cardId,
      command: { kind: 'open-card', cardId: input.cardId },
    };
  }
  const scale = zoomScaleForNextLevel(
    input.dataset,
    input.camera.scale,
    input.level,
  );
  const centered = centerFullNetworkCameraOnCard(
    input.dataset,
    { ...input.camera, scale },
    input.cardId,
    input.configuration,
  );
  return {
    camera: centered ?? input.camera,
    selectedCardId: input.cardId,
    command: { kind: 'none' },
  };
}

function closestNodeToViewportCenter(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
): number | null {
  if (dataset.overview.nodeCount === 0) return null;
  const center = fullNetworkWorldPoint(camera, {
    x: camera.viewportWidth / 2,
    y: camera.viewportHeight / 2,
  });
  let closest: Readonly<{ index: number; distance: number }> | null = null;
  for (let index = 0; index < dataset.overview.nodeCount; index += 1) {
    const point = nodePoint(dataset, index);
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    if (
      !closest ||
      distance < closest.distance ||
      (distance === closest.distance && index < closest.index)
    ) {
      closest = { index, distance };
    }
  }
  return closest?.index ?? null;
}

export function captureFullNetworkMapSnapshot(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  selectedCardId: CardId | null,
): FullNetworkMapSnapshot {
  const selectedIndex = selectedCardId
    ? dataset.nodeIndexesByCardId.get(selectedCardId)
    : undefined;
  const anchorIndex =
    selectedIndex ?? closestNodeToViewportCenter(dataset, camera);
  const anchorPoint =
    anchorIndex === null || anchorIndex === undefined
      ? null
      : nodePoint(dataset, anchorIndex);
  return {
    version: 1,
    topologyKey: dataset.routing.topologyKey,
    layoutKey: dataset.routing.layoutKey,
    camera: { ...camera },
    selectedCardId:
      selectedIndex === undefined ? null : nodeCardId(dataset, selectedIndex),
    anchor:
      anchorIndex === null || anchorIndex === undefined || !anchorPoint
        ? null
        : {
            cardId: nodeCardId(dataset, anchorIndex),
            viewportXRatio:
              (camera.offsetX + anchorPoint.x * camera.scale) /
              camera.viewportWidth,
            viewportYRatio:
              (camera.offsetY + anchorPoint.y * camera.scale) /
              camera.viewportHeight,
          },
  };
}

export function restoreFullNetworkMapSnapshot(
  input: Readonly<{
    dataset: FullNetworkRenderDataset;
    snapshot: FullNetworkMapSnapshot | null;
    viewportWidth: number;
    viewportHeight: number;
    configuration?: Partial<CameraConfiguration>;
  }>,
): FullNetworkCameraRestore {
  const fit = fitFullNetworkCamera(
    input.dataset,
    input.viewportWidth,
    input.viewportHeight,
    input.configuration,
  );
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.version !== 1) {
    return { camera: fit, selectedCardId: null, reason: 'fit' };
  }
  const selectedCardId =
    snapshot.selectedCardId &&
    input.dataset.nodeIndexesByCardId.has(snapshot.selectedCardId)
      ? snapshot.selectedCardId
      : null;
  if (snapshot.layoutKey === input.dataset.routing.layoutKey) {
    return {
      camera: resizeFullNetworkCamera(
        input.dataset,
        snapshot.camera,
        input.viewportWidth,
        input.viewportHeight,
        input.configuration,
      ),
      selectedCardId,
      reason: 'exact',
    };
  }
  const anchorIndex = snapshot.anchor
    ? input.dataset.nodeIndexesByCardId.get(snapshot.anchor.cardId)
    : undefined;
  if (snapshot.anchor && anchorIndex !== undefined) {
    const point = nodePoint(input.dataset, anchorIndex);
    return {
      camera: clampFullNetworkCamera(
        input.dataset,
        {
          offsetX:
            input.viewportWidth * snapshot.anchor.viewportXRatio -
            point.x * snapshot.camera.scale,
          offsetY:
            input.viewportHeight * snapshot.anchor.viewportYRatio -
            point.y * snapshot.camera.scale,
          scale: snapshot.camera.scale,
          viewportWidth: input.viewportWidth,
          viewportHeight: input.viewportHeight,
        },
        input.configuration,
      ),
      selectedCardId,
      reason: 'anchor',
    };
  }
  return { camera: fit, selectedCardId, reason: 'fit' };
}

export function currentFullNetworkSemanticLevel(
  dataset: FullNetworkRenderDataset,
  camera: FullNetworkRenderCamera,
  previousLevel?: FullNetworkSemanticLevel,
): FullNetworkSemanticLevel {
  return semanticLevel(dataset, camera, previousLevel);
}
