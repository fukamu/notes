'use client';

import {
  sameFullNetworkMapSessionScope,
  type FullNetworkMapSession,
} from '@/lib/application/full-network-map-session';
import type { NotesScope } from '@/lib/application/notes-runtime';
import type { CardId } from '@/lib/domain/id';
import {
  activateFullNetworkNode,
  captureFullNetworkMapSnapshot,
  centerFullNetworkCameraOnCard,
  currentFullNetworkSemanticLevel,
  defaultFullNetworkCameraConfiguration,
  fitFullNetworkCamera,
  hitTestFullNetworkNode,
  panFullNetworkCamera,
  pinchFullNetworkCamera,
  resizeFullNetworkCamera,
  restoreFullNetworkMapSnapshot,
  zoomFullNetworkCamera,
  type FullNetworkCameraRestoreReason,
  type FullNetworkScreenPoint,
} from '@/lib/graph/full-network-camera';
import type {
  FullNetworkRenderCamera,
  FullNetworkRenderDataset,
  FullNetworkSemanticLevel,
} from '@/lib/graph/full-network-render-plan';

export type FullNetworkCameraAdapterState = Readonly<{
  datasetKey: string;
  camera: FullNetworkRenderCamera;
  level: FullNetworkSemanticLevel;
  currentCardId: CardId | null;
  selectedCardId: CardId | null;
  restoreReason: FullNetworkCameraRestoreReason;
}>;

export type FullNetworkCameraAdapter = Readonly<{
  getState: () => FullNetworkCameraAdapterState;
  replaceDataset: (
    dataset: FullNetworkRenderDataset,
    currentCardId: CardId | null,
  ) => void;
  setCurrentCardId: (cardId: CardId | null) => void;
  resize: (width: number, height: number) => void;
  fitAll: () => void;
  centerCurrent: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  selectCard: (cardId: CardId) => void;
  activateAt: (point: FullNetworkScreenPoint) => void;
  activateCard: (cardId: CardId) => void;
  destroy: () => void;
}>;

type PointerStart = Readonly<{
  point: FullNetworkScreenPoint;
  camera: FullNetworkRenderCamera;
}>;

type PinchStart = Readonly<{
  points: readonly [FullNetworkScreenPoint, FullNetworkScreenPoint];
  camera: FullNetworkRenderCamera;
}>;

function pointerPair(
  pointers: ReadonlyMap<number, FullNetworkScreenPoint>,
): readonly [FullNetworkScreenPoint, FullNetworkScreenPoint] | null {
  const values = [...pointers.values()];
  const first = values[0];
  const second = values[1];
  return first && second ? [first, second] : null;
}

function viewportSize(viewport: HTMLElement): Readonly<{
  width: number;
  height: number;
}> {
  const bounds = viewport.getBoundingClientRect();
  return {
    width: Math.max(1, viewport.clientWidth || bounds.width),
    height: Math.max(1, viewport.clientHeight || bounds.height),
  };
}

export function createFullNetworkCameraAdapter(input: {
  readonly viewport: HTMLElement;
  readonly scope: NotesScope;
  readonly session: FullNetworkMapSession;
  readonly dataset: FullNetworkRenderDataset;
  readonly currentCardId: CardId | null;
  readonly onChange: (state: FullNetworkCameraAdapterState) => void;
  readonly onOpenCard: (cardId: CardId) => void;
}): FullNetworkCameraAdapter {
  if (!sameFullNetworkMapSessionScope(input.scope, input.session.scope)) {
    throw new Error('Full-network map session scope mismatch');
  }
  const initialSize = viewportSize(input.viewport);
  const initial = restoreFullNetworkMapSnapshot({
    dataset: input.dataset,
    snapshot: input.session.read(),
    viewportWidth: initialSize.width,
    viewportHeight: initialSize.height,
  });
  let dataset = input.dataset;
  let state: FullNetworkCameraAdapterState = {
    datasetKey: dataset.datasetKey,
    camera: initial.camera,
    level: currentFullNetworkSemanticLevel(dataset, initial.camera),
    currentCardId: input.currentCardId,
    selectedCardId: initial.selectedCardId,
    restoreReason: initial.reason,
  };
  let destroyed = false;
  const pointers = new Map<number, FullNetworkScreenPoint>();
  let pointerStart: PointerStart | null = null;
  let pinchStart: PinchStart | null = null;
  let gestureMoved = false;
  let suppressNextClick = false;
  let suppressionTimer: number | null = null;

  const persist = (): void => {
    input.session.write(
      captureFullNetworkMapSnapshot(
        dataset,
        state.camera,
        state.selectedCardId,
      ),
    );
  };
  const publish = (
    camera: FullNetworkRenderCamera,
    selectedCardId: CardId | null = state.selectedCardId,
    restoreReason: FullNetworkCameraRestoreReason = state.restoreReason,
  ): void => {
    if (destroyed) return;
    state = {
      ...state,
      datasetKey: dataset.datasetKey,
      camera,
      level: currentFullNetworkSemanticLevel(dataset, camera, state.level),
      selectedCardId,
      restoreReason,
    };
    input.viewport.dataset.cameraScale = String(camera.scale);
    input.viewport.dataset.cameraLevel = state.level;
    input.viewport.dataset.selectedCardId = selectedCardId ?? '';
    input.onChange(state);
  };

  const point = (event: PointerEvent | MouseEvent): FullNetworkScreenPoint => {
    const bounds = input.viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const viewportCenter = (): FullNetworkScreenPoint => ({
    x: state.camera.viewportWidth / 2,
    y: state.camera.viewportHeight / 2,
  });
  const capturePointers = (): void => {
    for (const pointerId of pointers.keys()) {
      if (!input.viewport.hasPointerCapture(pointerId)) {
        input.viewport.setPointerCapture(pointerId);
      }
    }
  };
  const releasePointers = (): void => {
    for (const pointerId of pointers.keys()) {
      if (input.viewport.hasPointerCapture(pointerId)) {
        input.viewport.releasePointerCapture(pointerId);
      }
    }
  };
  const resetPointerStart = (): void => {
    const remaining = [...pointers.values()][0];
    pointerStart = remaining
      ? { point: remaining, camera: state.camera }
      : null;
    pinchStart = null;
  };
  const resetPinchStart = (): void => {
    const pair = pointerPair(pointers);
    pinchStart = pair ? { points: pair, camera: state.camera } : null;
  };
  const suppressClick = (): void => {
    suppressNextClick = true;
    input.viewport.dataset.clickSuppression = 'true';
    if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
    suppressionTimer = window.setTimeout(() => {
      suppressNextClick = false;
      input.viewport.dataset.clickSuppression = 'false';
      suppressionTimer = null;
    }, 350);
  };
  const finishPointer = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    input.viewport.dataset.activePointers = String(pointers.size);
    if (input.viewport.hasPointerCapture(event.pointerId)) {
      input.viewport.releasePointerCapture(event.pointerId);
    }
    if (pointers.size >= 2) resetPinchStart();
    else if (pointers.size === 1) resetPointerStart();
    else {
      pointerStart = null;
      pinchStart = null;
      input.viewport.dataset.dragging = 'false';
      if (gestureMoved) suppressClick();
      gestureMoved = false;
    }
  };
  const handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const next = point(event);
    pointers.set(event.pointerId, next);
    input.viewport.dataset.activePointers = String(pointers.size);
    input.viewport.dataset.dragging = 'true';
    if (pointers.size >= 2) {
      gestureMoved = true;
      capturePointers();
      resetPinchStart();
    } else {
      pointerStart = { point: next, camera: state.camera };
    }
  };
  const handlePointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    const next = point(event);
    pointers.set(event.pointerId, next);
    const pair = pointerPair(pointers);
    if (pair) {
      if (!pinchStart) resetPinchStart();
      if (pinchStart) {
        publish(
          pinchFullNetworkCamera(
            dataset,
            pinchStart.camera,
            pinchStart.points,
            pair,
          ),
        );
      }
      gestureMoved = true;
      event.preventDefault();
      return;
    }
    if (!pointerStart) return;
    const delta = {
      x: next.x - pointerStart.point.x,
      y: next.y - pointerStart.point.y,
    };
    if (!gestureMoved && Math.hypot(delta.x, delta.y) < 6) return;
    gestureMoved = true;
    capturePointers();
    publish(panFullNetworkCamera(dataset, pointerStart.camera, delta));
    event.preventDefault();
  };
  const handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.target === input.viewport) finishPointer(event);
  };
  const activateCard = (cardId: CardId): void => {
    const activation = activateFullNetworkNode({
      dataset,
      camera: state.camera,
      cardId,
      level: state.level,
    });
    publish(activation.camera, activation.selectedCardId);
    if (activation.command.kind === 'open-card') {
      persist();
      input.onOpenCard(activation.command.cardId);
    }
  };
  const selectCard = (cardId: CardId): void => {
    if (!dataset.nodeIndexesByCardId.has(cardId)) return;
    publish(state.camera, cardId);
  };
  const activateAt = (screenPoint: FullNetworkScreenPoint): void => {
    const cardId = hitTestFullNetworkNode(dataset, state.camera, screenPoint);
    if (cardId) activateCard(cardId);
  };
  const handleClick = (event: MouseEvent): void => {
    if (suppressNextClick) {
      suppressNextClick = false;
      input.viewport.dataset.clickSuppression = 'false';
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      suppressionTimer = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    activateAt(point(event));
  };
  const handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    publish(
      zoomFullNetworkCamera(
        dataset,
        state.camera,
        Math.exp(-event.deltaY * 0.002),
        point(event),
      ),
    );
    event.preventDefault();
  };
  const fitAll = (): void => {
    publish(
      fitFullNetworkCamera(
        dataset,
        state.camera.viewportWidth,
        state.camera.viewportHeight,
      ),
      null,
      'fit',
    );
  };
  const centerCurrent = (): void => {
    if (!state.currentCardId) return;
    const camera = centerFullNetworkCameraOnCard(
      dataset,
      state.camera,
      state.currentCardId,
    );
    if (camera) publish(camera);
  };
  const zoom = (factor: number): void => {
    publish(
      zoomFullNetworkCamera(dataset, state.camera, factor, viewportCenter()),
    );
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const pan = defaultFullNetworkCameraConfiguration.keyboardPanPixels;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        publish(panFullNetworkCamera(dataset, state.camera, { x: pan, y: 0 }));
        break;
      case 'ArrowRight':
        publish(panFullNetworkCamera(dataset, state.camera, { x: -pan, y: 0 }));
        break;
      case 'ArrowUp':
        publish(panFullNetworkCamera(dataset, state.camera, { x: 0, y: pan }));
        break;
      case 'ArrowDown':
        publish(panFullNetworkCamera(dataset, state.camera, { x: 0, y: -pan }));
        break;
      case '+':
      case '=':
        zoom(defaultFullNetworkCameraConfiguration.zoomStep);
        break;
      case '-':
        zoom(1 / defaultFullNetworkCameraConfiguration.zoomStep);
        break;
      case '0':
        fitAll();
        break;
      case 'Home':
        centerCurrent();
        break;
      case 'Enter':
        if (state.level === 'detail' && state.selectedCardId) {
          activateCard(state.selectedCardId);
        } else {
          handled = false;
        }
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  input.viewport.dataset.activePointers = '0';
  input.viewport.dataset.dragging = 'false';
  input.viewport.dataset.clickSuppression = 'false';
  input.viewport.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  input.viewport.addEventListener(
    'lostpointercapture',
    handleLostPointerCapture,
  );
  input.viewport.addEventListener('click', handleClick);
  input.viewport.addEventListener('wheel', handleWheel, { passive: false });
  input.viewport.addEventListener('keydown', handleKeyDown);
  persist();
  input.onChange(state);

  return {
    getState: () => state,
    replaceDataset(nextDataset, currentCardId) {
      const snapshot = captureFullNetworkMapSnapshot(
        dataset,
        state.camera,
        state.selectedCardId,
      );
      dataset = nextDataset;
      const restored = restoreFullNetworkMapSnapshot({
        dataset,
        snapshot,
        viewportWidth: state.camera.viewportWidth,
        viewportHeight: state.camera.viewportHeight,
      });
      state = { ...state, currentCardId };
      publish(restored.camera, restored.selectedCardId, restored.reason);
    },
    setCurrentCardId(cardId) {
      if (destroyed || state.currentCardId === cardId) return;
      state = { ...state, currentCardId: cardId };
      input.onChange(state);
    },
    resize(width, height) {
      publish(resizeFullNetworkCamera(dataset, state.camera, width, height));
    },
    fitAll,
    centerCurrent,
    zoomIn: () => zoom(defaultFullNetworkCameraConfiguration.zoomStep),
    zoomOut: () => zoom(1 / defaultFullNetworkCameraConfiguration.zoomStep),
    selectCard,
    activateAt,
    activateCard,
    destroy() {
      if (destroyed) return;
      persist();
      destroyed = true;
      input.viewport.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      input.viewport.removeEventListener(
        'lostpointercapture',
        handleLostPointerCapture,
      );
      input.viewport.removeEventListener('click', handleClick);
      input.viewport.removeEventListener('wheel', handleWheel);
      input.viewport.removeEventListener('keydown', handleKeyDown);
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      releasePointers();
      pointers.clear();
      input.viewport.dataset.activePointers = '0';
      input.viewport.dataset.dragging = 'false';
      input.viewport.dataset.clickSuppression = 'false';
    },
  };
}
