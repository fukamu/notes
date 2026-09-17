'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  readConnectionsZoomPreference,
  writeConnectionsZoomPreference,
  type ConnectionsZoomPreferenceStorage,
} from '@/lib/client/connections-zoom-preference';
import { createConnectionsCanvasEdgeRenderer } from '@/lib/client/connections-canvas-renderer';
import type {
  ConnectionsReadyNode,
  ConnectionsReadyState,
} from '@/lib/graph/connections-contract';
import {
  centerConnectionsCameraOnRect,
  connectionsCameraContainsRect,
  connectionsCameraTransform,
  connectionsCameraZoomState,
  createConnectionsCameraFrameAdapter,
  DEFAULT_CONNECTIONS_CAMERA_LIMITS,
  ensureConnectionsRectVisible,
  fitConnectionsCamera,
  initialConnectionsCamera,
  panConnectionsCamera,
  pinchConnectionsCamera,
  preserveConnectionsRectAnchor,
  resolveConnectionsCameraLimits,
  resizeConnectionsCamera,
  zoomConnectionsCamera,
  type ConnectionsCamera,
  type ConnectionsCameraFrameAdapter,
  type ConnectionsCameraGeometry,
  type ConnectionsPoint,
  type ConnectionsViewportPadding,
} from '@/lib/graph/connections-viewport';
import {
  queryConnectionsVisibility,
  sameConnectionsVisibility,
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
  zoomOutputRef: React.RefObject<HTMLOutputElement | null>;
  zoomInRef: React.RefObject<HTMLButtonElement | null>;
  zoomOutRef: React.RefObject<HTMLButtonElement | null>;
  keyboardRef: React.RefObject<HTMLButtonElement | null>;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  centerCurrent: () => void;
  panBy: (delta: ConnectionsPoint) => void;
  ensureNodeVisible: (node: ConnectionsReadyNode) => void;
  visibility: ConnectionsVisibilitySelection | null;
};

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
): ConnectionsViewportController {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const edgeCanvasRef = useRef<HTMLCanvasElement>(null);
  const zoomOutputRef = useRef<HTMLOutputElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const keyboardRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef(model);
  const geometryModelRef = useRef<ConnectionsReadyState | null>(null);
  const paddingRef = useRef(padding);
  const preparedVisibilityRef = useRef(preparedVisibility);
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
  const [edgeRenderer] = useState(createConnectionsCanvasEdgeRenderer);
  const edgeColorsRef = useRef<Readonly<{
    halo: string;
    stroke: string;
  }> | null>(null);
  const visibilityRef = useRef<ConnectionsVisibilitySelection | null>(null);
  const visibilityLayoutKeyRef = useRef<string | null>(null);
  const [visibilityState, setVisibilityState] = useState<{
    layoutKey: string;
    selection: ConnectionsVisibilitySelection;
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
  }, [model, padding, preparedVisibility]);

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
    const next = queryConnectionsVisibility(prepared, camera, {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
    if (
      visibilityLayoutKeyRef.current === ready.layoutKey &&
      visibilityRef.current &&
      sameConnectionsVisibility(visibilityRef.current, next)
    ) {
      return visibilityRef.current;
    }
    visibilityLayoutKeyRef.current = ready.layoutKey;
    visibilityRef.current = next;
    setVisibilityState({ layoutKey: ready.layoutKey, selection: next });
    return next;
  }, []);

  const paintEdges = useCallback(
    (
      camera: ConnectionsCamera,
      selection: ConnectionsVisibilitySelection | null,
    ) => {
      const viewport = viewportRef.current;
      const canvas = edgeCanvasRef.current;
      const prepared = preparedVisibilityRef.current;
      if (!viewport || !canvas || !prepared || !selection) return;
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
      });
      viewport.dataset.edgeRenderer = 'canvas-2d';
      viewport.dataset.edgeRenderStatus = result.status;
      if (result.status === 'painted') {
        delete viewport.dataset.edgeRenderReason;
        viewport.dataset.edgeDrawCount = String(
          Number(viewport.dataset.edgeDrawCount ?? '0') + 1,
        );
        viewport.dataset.edgeDrawDurationMs = String(result.durationMs);
        viewport.dataset.edgePrepareDurationMs = String(
          result.prepareDurationMs,
        );
        viewport.dataset.edgeDrawEdgeCount = String(result.edgeCount);
      } else {
        viewport.dataset.edgeRenderReason = result.reason;
      }
    },
    [edgeRenderer],
  );

  const commitCamera = useCallback(
    (camera: ConnectionsCamera | null, persistScale = false) => {
      if (!camera) return;
      cameraRef.current = camera;
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
    geometryRef.current = geometry;
    layoutKeyRef.current = ready.layoutKey;
    geometryModelRef.current = ready;
    if (!previousCamera || !previousGeometry) {
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
        const zoomState = connectionsCameraZoomState(
          camera,
          geometryRef.current?.limits ?? DEFAULT_CONNECTIONS_CAMERA_LIMITS,
        );
        if (zoomState && zoomOutputRef.current) {
          zoomOutputRef.current.textContent = `${zoomState.percentLabel}%`;
        }
        if (zoomState && zoomInRef.current) {
          zoomInRef.current.disabled = zoomState.zoomInDisabled;
        }
        if (zoomState && zoomOutRef.current) {
          zoomOutRef.current.disabled = zoomState.zoomOutDisabled;
        }
        const selection = updateVisibility(camera);
        paintEdges(camera, selection);
      },
    });
    frameAdapterRef.current = adapter;
    if (cameraRef.current) adapter.queue(cameraRef.current);
    return () => {
      adapter.destroy();
      if (frameAdapterRef.current === adapter) frameAdapterRef.current = null;
    };
  }, [model?.layoutKey, paintEdges, updateVisibility]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const redraw = () => {
      edgeColorsRef.current = null;
      const camera = cameraRef.current;
      if (camera) paintEdges(camera, visibilityRef.current);
    };
    const observer = new MutationObserver(redraw);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, [paintEdges]);

  useLayoutEffect(
    () => () => {
      edgeRenderer.reset();
    },
    [edgeRenderer],
  );

  useLayoutEffect(() => {
    synchronizeGeometry();
  }, [
    model?.height,
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
      commitCameraWithVisibility(panConnectionsCamera(camera, delta, geometry));
    },
    [commitCameraWithVisibility, readGeometry],
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
    const keyboard = keyboardRef.current;
    if (!viewport || !keyboard) return;
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
      if (!suppressNextClick) return;
      suppressNextClick = false;
      viewport.dataset.clickSuppression = 'false';
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      suppressionTimer = null;
      event.preventDefault();
      event.stopImmediatePropagation();
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
    keyboard.addEventListener('keydown', handleKeyDown);
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
      keyboard.removeEventListener('keydown', handleKeyDown);
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
      ? visibilityState.selection
      : null;
  return {
    viewportRef,
    worldRef,
    edgeCanvasRef,
    zoomOutputRef,
    zoomInRef,
    zoomOutRef,
    keyboardRef,
    zoomIn: () => zoomAtViewportCenter(1.25),
    zoomOut: () => zoomAtViewportCenter(0.8),
    fit,
    centerCurrent,
    panBy,
    ensureNodeVisible,
    visibility: visibleSelection,
  };
}
