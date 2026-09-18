'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  readConnectionsZoomPreference,
  writeConnectionsZoomPreference,
  type ConnectionsZoomPreferenceStorage,
} from '@/lib/client/connections-zoom-preference';
import { createConnectionsCanvasCardRenderer } from '@/lib/client/connections-card-canvas-renderer';
import { createConnectionsCanvasEdgeRenderer } from '@/lib/client/connections-canvas-renderer';
import type { CardId } from '@/lib/domain/id';
import type { NotesViewStatePorts } from '@/lib/application/notes-view-state';
import type {
  ConnectionsReadyNode,
  ConnectionsReadyState,
} from '@/lib/graph/connections-contract';
import {
  centerConnectionsCameraOnRect,
  captureConnectionsCameraSnapshot,
  connectionsCameraContainsRect,
  connectionsCameraTransform,
  createConnectionsCameraFrameAdapter,
  ensureConnectionsRectVisible,
  fitConnectionsCamera,
  initialConnectionsCamera,
  panConnectionsCamera,
  pinchConnectionsCamera,
  preserveConnectionsRectAnchor,
  resolveConnectionsCameraLimits,
  resizeConnectionsCamera,
  restoreConnectionsCameraSnapshot,
  zoomConnectionsCamera,
  type ConnectionsCamera,
  type ConnectionsCameraFrameAdapter,
  type ConnectionsCameraGeometry,
  type ConnectionsPoint,
  type ConnectionsViewportPadding,
} from '@/lib/graph/connections-viewport';
import {
  hitTestConnectionsNode,
  queryConnectionsVisibility,
  resolveConnectionsNodeRenderMode,
  sameConnectionsVisibility,
  type ConnectionsNodeRenderMode,
  type ConnectionsVisibilitySelection,
  type PreparedConnectionsVisibility,
} from '@/lib/graph/connections-visibility';

type PinchStart = {
  camera: ConnectionsCamera;
  points: readonly [ConnectionsPoint, ConnectionsPoint];
};

export type ConnectionsViewportController = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  worldRef: React.RefObject<HTMLDivElement | null>;
  edgeCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  cardCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  ensureNodeVisible: (node: ConnectionsReadyNode) => void;
  visibility: ConnectionsVisibilitySelection | null;
  nodeRenderMode: ConnectionsNodeRenderMode;
};

type ConnectionsViewportRenderSelection = Readonly<{
  selection: ConnectionsVisibilitySelection;
  nodeRenderMode: ConnectionsNodeRenderMode;
}>;

function pointerPair(
  pointers: ReadonlyMap<number, ConnectionsPoint>,
): readonly [ConnectionsPoint, ConnectionsPoint] | null {
  const points = [...pointers.values()];
  const first = points[0];
  const second = points[1];
  return first && second ? [first, second] : null;
}

export function useConnectionsViewport(
  model: ConnectionsReadyState | null,
  padding: ConnectionsViewportPadding,
  preparedVisibility: PreparedConnectionsVisibility | null,
  retainedNodeIndex: number | null,
  openOverviewCard: (cardId: CardId) => void,
  cameraPosition: NotesViewStatePorts['connections'],
): ConnectionsViewportController {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const edgeCanvasRef = useRef<HTMLCanvasElement>(null);
  const cardCanvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef(model);
  const geometryModelRef = useRef<ConnectionsReadyState | null>(null);
  const paddingRef = useRef(padding);
  const preparedVisibilityRef = useRef(preparedVisibility);
  const retainedNodeIndexRef = useRef(retainedNodeIndex);
  const openOverviewCardRef = useRef(openOverviewCard);
  const cameraPositionRef = useRef(cameraPosition);
  const geometryRef = useRef<ConnectionsCameraGeometry | null>(null);
  const cameraRef = useRef<ConnectionsCamera | null>(null);
  const preferredScaleRef = useRef<number | null>(null);
  const preferenceStorageRef = useRef<ConnectionsZoomPreferenceStorage | null>(
    null,
  );
  const pendingPreferredScaleRef = useRef<number | null>(null);
  const preferenceTimerRef = useRef<number | null>(null);
  const layoutKeyRef = useRef<string | null>(null);
  const frameAdapterRef = useRef<ConnectionsCameraFrameAdapter | null>(null);
  const rasterSettleTimerRef = useRef<number | null>(null);
  const [edgeRenderer] = useState(createConnectionsCanvasEdgeRenderer);
  const [cardRenderer] = useState(createConnectionsCanvasCardRenderer);
  const edgeColorsRef = useRef<Readonly<{
    halo: string;
    stroke: string;
  }> | null>(null);
  const cardColorsRef = useRef<Readonly<{
    fill: string;
    border: string;
    current: string;
  }> | null>(null);
  const visibilityRef = useRef<ConnectionsVisibilitySelection | null>(null);
  const nodeRenderModeRef = useRef<ConnectionsNodeRenderMode>('html');
  const visibilityLayoutKeyRef = useRef<string | null>(null);
  const [visibilityState, setVisibilityState] = useState<{
    layoutKey: string;
    renderSelection: ConnectionsViewportRenderSelection;
  } | null>(null);

  const flushPreferredScale = useCallback(() => {
    const scale = pendingPreferredScaleRef.current;
    pendingPreferredScaleRef.current = null;
    if (preferenceTimerRef.current !== null) {
      window.clearTimeout(preferenceTimerRef.current);
      preferenceTimerRef.current = null;
    }
    if (scale !== null) {
      writeConnectionsZoomPreference(preferenceStorageRef.current, scale);
    }
  }, []);

  const queuePreferredScale = useCallback(
    (scale: number) => {
      preferredScaleRef.current = scale;
      pendingPreferredScaleRef.current = scale;
      if (preferenceTimerRef.current !== null) {
        window.clearTimeout(preferenceTimerRef.current);
      }
      preferenceTimerRef.current = window.setTimeout(flushPreferredScale, 120);
    },
    [flushPreferredScale],
  );

  useLayoutEffect(() => {
    try {
      preferenceStorageRef.current = window.localStorage;
    } catch {
      preferenceStorageRef.current = null;
    }
    preferredScaleRef.current = readConnectionsZoomPreference(
      preferenceStorageRef.current,
    );
    return () => {
      flushPreferredScale();
      preferenceStorageRef.current = null;
    };
  }, [flushPreferredScale]);

  useLayoutEffect(() => {
    modelRef.current = model;
    paddingRef.current = padding;
    preparedVisibilityRef.current = preparedVisibility;
    retainedNodeIndexRef.current = retainedNodeIndex;
    openOverviewCardRef.current = openOverviewCard;
    cameraPositionRef.current = cameraPosition;
  }, [
    cameraPosition,
    model,
    openOverviewCard,
    padding,
    preparedVisibility,
    retainedNodeIndex,
  ]);

  const readGeometry = useCallback((): ConnectionsCameraGeometry | null => {
    const viewport = viewportRef.current;
    const ready = modelRef.current;
    const prepared = preparedVisibilityRef.current;
    if (!viewport || !ready || !prepared) return null;
    const viewportGeometry = {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    };
    const limits = resolveConnectionsCameraLimits(
      viewportGeometry,
      prepared.worldBounds,
      paddingRef.current,
    );
    if (!limits) return null;
    return {
      viewport: viewportGeometry,
      world: prepared.worldBounds,
      padding: paddingRef.current,
      limits,
    };
  }, []);

  const updateVisibility = useCallback((camera: ConnectionsCamera) => {
    const viewport = viewportRef.current;
    const prepared = preparedVisibilityRef.current;
    const ready = modelRef.current;
    if (!viewport || !prepared || !ready) return null;
    const started = performance.now();
    const next = queryConnectionsVisibility(prepared, camera, {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
    const nodeRenderMode = resolveConnectionsNodeRenderMode(
      ready.nodes[0]?.height ?? 0,
      camera.scale,
    );
    viewport.dataset.visibilityQueryDurationMs = String(
      performance.now() - started,
    );
    if (
      visibilityLayoutKeyRef.current === ready.layoutKey &&
      visibilityRef.current &&
      sameConnectionsVisibility(visibilityRef.current, next) &&
      nodeRenderModeRef.current === nodeRenderMode
    ) {
      return {
        selection: visibilityRef.current,
        nodeRenderMode,
      };
    }
    visibilityLayoutKeyRef.current = ready.layoutKey;
    visibilityRef.current = next;
    nodeRenderModeRef.current = nodeRenderMode;
    viewport.dataset.nodeRenderRequestedAt = String(performance.now());
    const renderSelection = { selection: next, nodeRenderMode };
    setVisibilityState({ layoutKey: ready.layoutKey, renderSelection });
    return renderSelection;
  }, []);

  const paintEdges = useCallback(
    (
      camera: ConnectionsCamera,
      selection: ConnectionsVisibilitySelection | null,
      nodeRenderMode: ConnectionsNodeRenderMode,
      forceRasterRefresh = false,
    ) => {
      const viewport = viewportRef.current;
      const canvas = edgeCanvasRef.current;
      const prepared = preparedVisibilityRef.current;
      if (!viewport || !canvas || !prepared || !selection) return false;
      let colors = edgeColorsRef.current;
      if (!colors) {
        const styles = window.getComputedStyle(viewport);
        colors = {
          halo:
            styles.getPropertyValue('--card').trim() || styles.backgroundColor,
          stroke: styles.getPropertyValue('--primary').trim() || styles.color,
        };
        edgeColorsRef.current = colors;
      }
      const result = edgeRenderer.paint({
        canvas,
        prepared,
        visibleEdgeIndices: selection.edgeIndices,
        camera,
        viewport: {
          width: viewport.clientWidth,
          height: viewport.clientHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
        colors,
        mode: nodeRenderMode === 'overview-canvas' ? 'bounded-cache' : 'direct',
        forceRasterRefresh,
      });
      viewport.dataset.edgeRenderer = 'canvas-2d';
      viewport.dataset.edgeRenderStatus = result.status;
      if (result.status === 'painted') {
        delete viewport.dataset.edgeRenderReason;
        viewport.dataset.edgeDrawCount = String(
          Number(viewport.dataset.edgeDrawCount ?? '0') + 1,
        );
        viewport.dataset.edgeDrawDurationMs = String(result.durationMs);
        viewport.dataset.edgeDrawStrategy = result.strategy;
        viewport.dataset.edgeRasterRenderDurationMs = String(
          result.rasterRenderDurationMs,
        );
        viewport.dataset.edgeRasterCachePixelWidth = String(
          result.cachePixelWidth,
        );
        viewport.dataset.edgeRasterCachePixelHeight = String(
          result.cachePixelHeight,
        );
        if (result.strategy === 'raster-refresh') {
          viewport.dataset.edgeRasterRefreshCount = String(
            Number(viewport.dataset.edgeRasterRefreshCount ?? '0') + 1,
          );
        }
        if (result.strategy === 'raster-reuse') {
          viewport.dataset.edgeRasterReuseCount = String(
            Number(viewport.dataset.edgeRasterReuseCount ?? '0') + 1,
          );
        }
        viewport.dataset.edgePrepareDurationMs = String(
          result.prepareDurationMs,
        );
        viewport.dataset.edgeDrawEdgeCount = String(result.edgeCount);
      } else {
        viewport.dataset.edgeRenderReason = result.reason;
      }
      return result.status === 'painted' && result.scaledRaster;
    },
    [edgeRenderer],
  );

  const paintCards = useCallback(
    (
      camera: ConnectionsCamera,
      renderSelection: ConnectionsViewportRenderSelection | null,
      forceRasterRefresh = false,
    ) => {
      const viewport = viewportRef.current;
      const canvas = cardCanvasRef.current;
      const ready = modelRef.current;
      if (!viewport || !canvas || !ready || !renderSelection) return false;
      const viewportGeometry = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      };
      const result =
        renderSelection.nodeRenderMode === 'overview-canvas'
          ? (() => {
              let colors = cardColorsRef.current;
              if (!colors) {
                const styles = window.getComputedStyle(viewport);
                colors = {
                  fill:
                    styles.getPropertyValue('--card').trim() ||
                    styles.backgroundColor,
                  border:
                    styles.getPropertyValue('--border').trim() || styles.color,
                  current:
                    styles.getPropertyValue('--primary').trim() || styles.color,
                };
                cardColorsRef.current = colors;
              }
              return cardRenderer.paint({
                canvas,
                nodes: ready.nodes,
                visibleNodeIndices: renderSelection.selection.nodeIndices,
                excludedNodeIndex: retainedNodeIndexRef.current,
                camera,
                viewport: viewportGeometry,
                devicePixelRatio: window.devicePixelRatio,
                colors,
                mode: 'bounded-cache',
                forceRasterRefresh,
              });
            })()
          : cardRenderer.clear({
              canvas,
              viewport: viewportGeometry,
              devicePixelRatio: window.devicePixelRatio,
            });
      viewport.dataset.cardRenderer =
        renderSelection.nodeRenderMode === 'overview-canvas'
          ? 'canvas-2d-overview'
          : 'html-windowed';
      viewport.dataset.cardRenderStatus = result.status;
      if (result.status === 'unavailable') {
        viewport.dataset.cardRenderReason = result.reason;
        return;
      }
      delete viewport.dataset.cardRenderReason;
      viewport.dataset.cardDrawCount = String(
        Number(viewport.dataset.cardDrawCount ?? '0') + 1,
      );
      viewport.dataset.cardDrawNodeCount = String(result.nodeCount);
      viewport.dataset.cardDrawDurationMs = String(result.durationMs);
      if (result.status === 'painted') {
        viewport.dataset.cardDrawStrategy = result.strategy;
        viewport.dataset.cardRasterRenderDurationMs = String(
          result.rasterRenderDurationMs,
        );
        viewport.dataset.cardRasterCachePixelWidth = String(
          result.cachePixelWidth,
        );
        viewport.dataset.cardRasterCachePixelHeight = String(
          result.cachePixelHeight,
        );
        if (result.strategy === 'raster-refresh') {
          viewport.dataset.cardRasterRefreshCount = String(
            Number(viewport.dataset.cardRasterRefreshCount ?? '0') + 1,
          );
        }
        if (result.strategy === 'raster-reuse') {
          viewport.dataset.cardRasterReuseCount = String(
            Number(viewport.dataset.cardRasterReuseCount ?? '0') + 1,
          );
        }
      }
      return result.status === 'painted' && result.scaledRaster;
    },
    [cardRenderer],
  );

  const settleScaledRaster = useCallback(
    (required: boolean) => {
      if (rasterSettleTimerRef.current !== null) {
        window.clearTimeout(rasterSettleTimerRef.current);
        rasterSettleTimerRef.current = null;
      }
      if (!required) return;
      rasterSettleTimerRef.current = window.setTimeout(() => {
        rasterSettleTimerRef.current = null;
        const camera = cameraRef.current;
        const selection = visibilityRef.current;
        if (!camera || !selection) return;
        const renderSelection = {
          selection,
          nodeRenderMode: nodeRenderModeRef.current,
        };
        paintEdges(camera, selection, renderSelection.nodeRenderMode, true);
        paintCards(camera, renderSelection, true);
      }, 120);
    },
    [paintCards, paintEdges],
  );

  const commitCamera = useCallback(
    (camera: ConnectionsCamera | null, persistScale = false) => {
      if (!camera) return;
      cameraRef.current = camera;
      const geometry = geometryRef.current;
      const ready = modelRef.current;
      const geometryModel = geometryModelRef.current;
      if (
        geometry &&
        ready &&
        geometryModel?.currentCardId === ready.currentCardId &&
        geometryModel.layoutKey === ready.layoutKey
      ) {
        const snapshot = captureConnectionsCameraSnapshot(
          ready.currentCardId,
          ready.layoutKey,
          camera,
          geometry,
        );
        if (snapshot) cameraPositionRef.current.write(snapshot);
      }
      frameAdapterRef.current?.queue(camera);
      if (persistScale) queuePreferredScale(camera.scale);
    },
    [queuePreferredScale],
  );

  const commitCameraWithVisibility = useCallback(
    (camera: ConnectionsCamera | null, persistScale = false) => {
      if (camera) updateVisibility(camera);
      commitCamera(camera, persistScale);
    },
    [commitCamera, updateVisibility],
  );

  const synchronizeGeometry = useCallback(() => {
    const geometry = readGeometry();
    const ready = modelRef.current;
    if (!geometry || !ready) return;
    const previousGeometry = geometryRef.current;
    const previousCamera = cameraRef.current;
    const previousModel = geometryModelRef.current;
    const layoutChanged = layoutKeyRef.current !== ready.layoutKey;
    const currentCardChanged =
      previousModel !== null &&
      previousModel.currentCardId !== ready.currentCardId;
    geometryRef.current = geometry;
    layoutKeyRef.current = ready.layoutKey;
    geometryModelRef.current = ready;
    if (!previousCamera || !previousGeometry) {
      const snapshot = cameraPositionRef.current.read();
      commitCameraWithVisibility(
        (snapshot &&
          restoreConnectionsCameraSnapshot(
            snapshot,
            ready.currentCardId,
            ready.layoutKey,
            geometry,
          )) ||
          initialConnectionsCamera(
            geometry,
            ready.currentNode,
            preferredScaleRef.current,
          ),
      );
      return;
    }
    if (currentCardChanged) {
      commitCameraWithVisibility(
        initialConnectionsCamera(
          geometry,
          ready.currentNode,
          preferredScaleRef.current,
        ),
      );
      return;
    }
    if (layoutChanged) {
      const previousAnchor = previousModel?.nodes.find(
        (node) => node.cardId === ready.currentCardId,
      );
      const nextAnchor = ready.nodes.find(
        (node) => node.cardId === ready.currentCardId,
      );
      commitCameraWithVisibility(
        previousAnchor && nextAnchor
          ? preserveConnectionsRectAnchor(
              previousCamera,
              previousAnchor,
              nextAnchor,
              geometry,
            )
          : resizeConnectionsCamera(previousCamera, previousGeometry, geometry),
      );
      return;
    }
    commitCameraWithVisibility(
      resizeConnectionsCamera(previousCamera, previousGeometry, geometry),
    );
  }, [commitCameraWithVisibility, readGeometry]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const world = worldRef.current;
    if (!viewport || !world) return;
    const adapter = createConnectionsCameraFrameAdapter({
      schedule: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
      apply: (camera) => {
        const transform = connectionsCameraTransform(camera);
        if (!transform) return;
        world.style.transform = transform;
        viewport.dataset.cameraX = String(camera.x);
        viewport.dataset.cameraY = String(camera.y);
        viewport.dataset.cameraScale = String(camera.scale);
        viewport.dataset.cameraRenderCount = String(
          Number(viewport.dataset.cameraRenderCount ?? '0') + 1,
        );
        const renderSelection = updateVisibility(camera);
        const scaledEdges = paintEdges(
          camera,
          renderSelection?.selection ?? null,
          renderSelection?.nodeRenderMode ?? 'html',
        );
        const scaledCards = paintCards(camera, renderSelection);
        settleScaledRaster(Boolean(scaledEdges || scaledCards));
      },
    });
    frameAdapterRef.current = adapter;
    if (cameraRef.current) adapter.queue(cameraRef.current);
    return () => {
      adapter.destroy();
      if (frameAdapterRef.current === adapter) frameAdapterRef.current = null;
    };
  }, [
    model?.layoutKey,
    paintCards,
    paintEdges,
    settleScaledRaster,
    updateVisibility,
  ]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const redraw = () => {
      edgeColorsRef.current = null;
      cardColorsRef.current = null;
      const camera = cameraRef.current;
      if (camera) {
        const renderSelection = visibilityRef.current
          ? {
              selection: visibilityRef.current,
              nodeRenderMode: nodeRenderModeRef.current,
            }
          : null;
        paintEdges(
          camera,
          renderSelection?.selection ?? null,
          renderSelection?.nodeRenderMode ?? 'html',
          true,
        );
        paintCards(camera, renderSelection);
      }
    };
    const observer = new MutationObserver(redraw);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, [paintCards, paintEdges]);

  useLayoutEffect(
    () => () => {
      edgeRenderer.reset();
      cardRenderer.reset();
      if (rasterSettleTimerRef.current !== null) {
        window.clearTimeout(rasterSettleTimerRef.current);
        rasterSettleTimerRef.current = null;
      }
    },
    [cardRenderer, edgeRenderer],
  );

  useLayoutEffect(() => {
    const camera = cameraRef.current;
    if (camera) frameAdapterRef.current?.queue(camera);
  }, [retainedNodeIndex]);

  useLayoutEffect(() => {
    synchronizeGeometry();
  }, [
    model?.height,
    model?.currentCardId,
    model?.layoutKey,
    model?.width,
    preparedVisibility?.worldBounds.height,
    preparedVisibility?.worldBounds.width,
    preparedVisibility?.worldBounds.x,
    preparedVisibility?.worldBounds.y,
    padding.bottom,
    padding.left,
    padding.right,
    padding.top,
    synchronizeGeometry,
  ]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(synchronizeGeometry);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [synchronizeGeometry]);

  const zoomAtViewportCenter = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      const geometry = geometryRef.current ?? readGeometry();
      const camera = cameraRef.current;
      if (!viewport || !geometry || !camera) return;
      commitCameraWithVisibility(
        zoomConnectionsCamera(
          camera,
          factor,
          { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
          geometry,
        ),
        true,
      );
    },
    [commitCameraWithVisibility, readGeometry],
  );

  const fit = useCallback(() => {
    const geometry = geometryRef.current ?? readGeometry();
    if (geometry) {
      commitCameraWithVisibility(fitConnectionsCamera(geometry), true);
    }
  }, [commitCameraWithVisibility, readGeometry]);

  const centerCurrent = useCallback(() => {
    const geometry = geometryRef.current ?? readGeometry();
    const camera = cameraRef.current;
    const currentNode = modelRef.current?.currentNode;
    if (!geometry || !camera || !currentNode) return;
    const operableCamera = {
      ...camera,
      scale: Math.max(camera.scale, Math.min(1, geometry.limits.maximumScale)),
    };
    const centered = centerConnectionsCameraOnRect(
      operableCamera,
      currentNode,
      geometry,
    );
    commitCameraWithVisibility(
      centered
        ? ensureConnectionsRectVisible(centered, currentNode, geometry, 12)
        : null,
    );
  }, [commitCameraWithVisibility, readGeometry]);

  const panBy = useCallback(
    (delta: ConnectionsPoint) => {
      const geometry = geometryRef.current ?? readGeometry();
      const camera = cameraRef.current;
      if (!geometry || !camera) return;
      commitCamera(panConnectionsCamera(camera, delta, geometry));
    },
    [commitCamera, readGeometry],
  );

  const ensureNodeVisible = useCallback(
    (node: ConnectionsReadyNode) => {
      const geometry = geometryRef.current ?? readGeometry();
      const camera = cameraRef.current;
      if (!geometry || !camera) return;
      const operableScale = Math.max(
        camera.scale,
        Math.min(0.5, geometry.limits.maximumScale),
      );
      const operableCamera = { ...camera, scale: operableScale };
      if (
        operableScale === camera.scale &&
        connectionsCameraContainsRect(camera, node, geometry, 12)
      ) {
        return;
      }
      commitCameraWithVisibility(
        ensureConnectionsRectVisible(operableCamera, node, geometry, 12),
      );
    },
    [commitCameraWithVisibility, readGeometry],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const pointers = new Map<number, ConnectionsPoint>();
    let dragStartPoint: ConnectionsPoint | null = null;
    let dragStartCamera: ConnectionsCamera | null = null;
    let pinchStart: PinchStart | null = null;
    let gestureMoved = false;
    let suppressNextClick = false;
    let suppressionTimer: number | null = null;

    const point = (event: PointerEvent): ConnectionsPoint => {
      const bounds = viewport.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const capturePointers = () => {
      for (const pointerId of pointers.keys()) {
        if (!viewport.hasPointerCapture(pointerId)) {
          viewport.setPointerCapture(pointerId);
        }
      }
    };
    const releasePointerCaptures = () => {
      for (const pointerId of pointers.keys()) {
        if (viewport.hasPointerCapture(pointerId)) {
          viewport.releasePointerCapture(pointerId);
        }
      }
    };
    const resetSinglePointerStart = () => {
      const remaining = [...pointers.values()][0] ?? null;
      dragStartPoint = remaining;
      dragStartCamera = cameraRef.current;
      pinchStart = null;
    };
    const resetPinchStart = () => {
      const points = pointerPair(pointers);
      const camera = cameraRef.current;
      pinchStart = points && camera ? { camera, points } : null;
    };
    const suppressClickAfterGesture = () => {
      suppressNextClick = true;
      viewport.dataset.clickSuppression = 'true';
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      suppressionTimer = window.setTimeout(() => {
        suppressNextClick = false;
        viewport.dataset.clickSuppression = 'false';
        suppressionTimer = null;
      }, 350);
    };
    const finishPointer = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      viewport.dataset.activePointers = String(pointers.size);
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
      if (pointers.size >= 2) resetPinchStart();
      else if (pointers.size === 1) resetSinglePointerStart();
      else {
        dragStartPoint = null;
        dragStartCamera = null;
        pinchStart = null;
        viewport.dataset.dragging = 'false';
        if (gestureMoved) suppressClickAfterGesture();
        gestureMoved = false;
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (
        pointers.size > 0 &&
        (event.pointerType === 'mouse' ||
          (event.isPrimary && !pointers.has(event.pointerId)))
      ) {
        releasePointerCaptures();
        pointers.clear();
        dragStartPoint = null;
        dragStartCamera = null;
        pinchStart = null;
        gestureMoved = false;
      }
      const nextPoint = point(event);
      pointers.set(event.pointerId, nextPoint);
      viewport.dataset.activePointers = String(pointers.size);
      viewport.dataset.dragging = 'true';
      if (pointers.size >= 2) {
        gestureMoved = true;
        capturePointers();
        resetPinchStart();
      } else {
        dragStartPoint = nextPoint;
        dragStartCamera = cameraRef.current;
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const nextPoint = point(event);
      pointers.set(event.pointerId, nextPoint);
      const geometry = geometryRef.current;
      if (!geometry) return;
      const pair = pointerPair(pointers);
      if (pair) {
        if (!pinchStart) resetPinchStart();
        if (pinchStart) {
          commitCamera(
            pinchConnectionsCamera(
              pinchStart.camera,
              pinchStart.points,
              pair,
              geometry,
            ),
            true,
          );
        }
        gestureMoved = true;
        event.preventDefault();
        return;
      }
      if (!dragStartPoint || !dragStartCamera) return;
      const delta = {
        x: nextPoint.x - dragStartPoint.x,
        y: nextPoint.y - dragStartPoint.y,
      };
      if (!gestureMoved && Math.hypot(delta.x, delta.y) < 6) return;
      gestureMoved = true;
      capturePointers();
      commitCamera(panConnectionsCamera(dragStartCamera, delta, geometry));
      event.preventDefault();
    };
    const handleLostPointerCapture = (event: PointerEvent) => {
      if (event.target !== viewport) return;
      if (pointers.has(event.pointerId)) finishPointer(event);
    };
    const handleClick = (event: MouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        viewport.dataset.clickSuppression = 'false';
        if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
        suppressionTimer = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (nodeRenderModeRef.current !== 'overview-canvas') return;
      if (event.target instanceof Element && event.target.closest('button')) {
        return;
      }
      const camera = cameraRef.current;
      const prepared = preparedVisibilityRef.current;
      const ready = modelRef.current;
      if (!camera || !prepared || !ready) return;
      const bounds = viewport.getBoundingClientRect();
      const nodeIndex = hitTestConnectionsNode(prepared, camera, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
      const node = nodeIndex === null ? null : ready.nodes[nodeIndex];
      viewport.dataset.overviewHitTestCount = String(
        Number(viewport.dataset.overviewHitTestCount ?? '0') + 1,
      );
      viewport.dataset.overviewHitCardId = node?.cardId ?? '';
      if (!node) return;
      openOverviewCardRef.current(node.cardId);
      event.preventDefault();
    };
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const geometry = geometryRef.current;
      const camera = cameraRef.current;
      if (!geometry || !camera) return;
      const bounds = viewport.getBoundingClientRect();
      commitCamera(
        zoomConnectionsCamera(
          camera,
          Math.exp(-event.deltaY * 0.002),
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
          geometry,
        ),
        true,
      );
      event.preventDefault();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target !== viewport) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      let handled = true;
      switch (event.key) {
        case 'ArrowLeft':
          panBy({ x: 64, y: 0 });
          break;
        case 'ArrowRight':
          panBy({ x: -64, y: 0 });
          break;
        case 'ArrowUp':
          panBy({ x: 0, y: 64 });
          break;
        case 'ArrowDown':
          panBy({ x: 0, y: -64 });
          break;
        case '+':
        case '=':
          zoomAtViewportCenter(1.25);
          break;
        case '-':
          zoomAtViewportCenter(0.8);
          break;
        case '0':
          fit();
          break;
        case 'Home':
          centerCurrent();
          break;
        default:
          handled = false;
      }
      if (handled) event.preventDefault();
    };

    viewport.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);
    viewport.addEventListener('lostpointercapture', handleLostPointerCapture);
    viewport.addEventListener('click', handleClick, true);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('keydown', handleKeyDown);
    return () => {
      viewport.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      viewport.removeEventListener(
        'lostpointercapture',
        handleLostPointerCapture,
      );
      viewport.removeEventListener('click', handleClick, true);
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('keydown', handleKeyDown);
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      releasePointerCaptures();
      pointers.clear();
      viewport.dataset.activePointers = '0';
      viewport.dataset.dragging = 'false';
      viewport.dataset.clickSuppression = 'false';
    };
  }, [
    centerCurrent,
    commitCamera,
    fit,
    model?.layoutKey,
    panBy,
    zoomAtViewportCenter,
  ]);

  const visibleSelection =
    model && visibilityState?.layoutKey === model.layoutKey
      ? visibilityState.renderSelection.selection
      : null;
  const nodeRenderMode =
    model && visibilityState?.layoutKey === model.layoutKey
      ? visibilityState.renderSelection.nodeRenderMode
      : 'html';
  return {
    viewportRef,
    worldRef,
    edgeCanvasRef,
    cardCanvasRef,
    ensureNodeVisible,
    visibility: visibleSelection,
    nodeRenderMode,
  };
}
