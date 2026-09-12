'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
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
  resizeConnectionsCamera,
  zoomConnectionsCamera,
  type ConnectionsCamera,
  type ConnectionsCameraFrameAdapter,
  type ConnectionsCameraGeometry,
  type ConnectionsPoint,
  type ConnectionsViewportPadding,
} from '@/lib/graph/connections-viewport';

type PinchStart = {
  camera: ConnectionsCamera;
  points: readonly [ConnectionsPoint, ConnectionsPoint];
};

export type ConnectionsViewportController = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  worldRef: React.RefObject<HTMLDivElement | null>;
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
): ConnectionsViewportController {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const zoomOutputRef = useRef<HTMLOutputElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);
  const keyboardRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef(model);
  const paddingRef = useRef(padding);
  const geometryRef = useRef<ConnectionsCameraGeometry | null>(null);
  const cameraRef = useRef<ConnectionsCamera | null>(null);
  const layoutKeyRef = useRef<string | null>(null);
  const frameAdapterRef = useRef<ConnectionsCameraFrameAdapter | null>(null);
  useLayoutEffect(() => {
    modelRef.current = model;
    paddingRef.current = padding;
  }, [model, padding]);

  const readGeometry = useCallback((): ConnectionsCameraGeometry | null => {
    const viewport = viewportRef.current;
    const ready = modelRef.current;
    if (!viewport || !ready) return null;
    return {
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      },
      world: { x: 0, y: 0, width: ready.width, height: ready.height },
      padding: paddingRef.current,
      limits: DEFAULT_CONNECTIONS_CAMERA_LIMITS,
    };
  }, []);

  const commitCamera = useCallback((camera: ConnectionsCamera | null) => {
    if (!camera) return;
    cameraRef.current = camera;
    frameAdapterRef.current?.queue(camera);
  }, []);

  const synchronizeGeometry = useCallback(() => {
    const geometry = readGeometry();
    const ready = modelRef.current;
    if (!geometry || !ready) return;
    const previousGeometry = geometryRef.current;
    const previousCamera = cameraRef.current;
    const layoutChanged = layoutKeyRef.current !== ready.layoutKey;
    geometryRef.current = geometry;
    layoutKeyRef.current = ready.layoutKey;
    if (!previousCamera || !previousGeometry || layoutChanged) {
      commitCamera(initialConnectionsCamera(geometry, ready.currentNode));
      return;
    }
    commitCamera(
      resizeConnectionsCamera(previousCamera, previousGeometry, geometry),
    );
  }, [commitCamera, readGeometry]);

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
          zoomOutputRef.current.textContent = `${zoomState.percent}%`;
        }
        if (zoomState && zoomInRef.current) {
          zoomInRef.current.disabled = zoomState.zoomInDisabled;
        }
        if (zoomState && zoomOutRef.current) {
          zoomOutRef.current.disabled = zoomState.zoomOutDisabled;
        }
      },
    });
    frameAdapterRef.current = adapter;
    if (cameraRef.current) adapter.queue(cameraRef.current);
    return () => {
      adapter.destroy();
      if (frameAdapterRef.current === adapter) frameAdapterRef.current = null;
    };
  }, [model?.layoutKey]);

  useLayoutEffect(() => {
    synchronizeGeometry();
  }, [
    model?.height,
    model?.layoutKey,
    model?.width,
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
      commitCamera(
        zoomConnectionsCamera(
          camera,
          factor,
          { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
          geometry,
        ),
      );
    },
    [commitCamera, readGeometry],
  );

  const fit = useCallback(() => {
    const geometry = geometryRef.current ?? readGeometry();
    if (geometry) commitCamera(fitConnectionsCamera(geometry));
  }, [commitCamera, readGeometry]);

  const centerCurrent = useCallback(() => {
    const geometry = geometryRef.current ?? readGeometry();
    const camera = cameraRef.current;
    const currentNode = modelRef.current?.currentNode;
    if (!geometry || !camera || !currentNode) return;
    const centered = centerConnectionsCameraOnRect(
      camera,
      currentNode,
      geometry,
    );
    commitCamera(
      centered
        ? ensureConnectionsRectVisible(centered, currentNode, geometry, 12)
        : null,
    );
  }, [commitCamera, readGeometry]);

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
      if (connectionsCameraContainsRect(camera, node, geometry, 12)) return;
      commitCamera(ensureConnectionsRectVisible(camera, node, geometry, 12));
    },
    [commitCamera, readGeometry],
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

  return {
    viewportRef,
    worldRef,
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
  };
}
