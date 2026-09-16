import {
  createFullNetworkMapSession,
  type FullNetworkMapSession,
} from '@/lib/application/full-network-map-session';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  createFullNetworkCameraAdapter,
  type FullNetworkCameraAdapterState,
} from '@/lib/client/full-network-camera-adapter';
import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
} from '@/lib/domain/identity';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  createFullNetworkRenderDataset,
  type FullNetworkRenderDataset,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { fixtureCardId } from '@/tests/fixtures/ids';

type SerializableState = Readonly<{
  level: 'overview' | 'network' | 'detail';
  scale: number;
  offsetX: number;
  offsetY: number;
  currentCardId: CardId | null;
  selectedCardId: CardId | null;
  restoreReason: 'exact' | 'anchor' | 'fit';
  openedCardId: CardId | null;
  route: 'map' | 'card';
}>;

type CameraHarness = Readonly<{
  initialize: (currentIndex?: number) => SerializableState;
  state: () => SerializableState;
  nodePoint: (index: number) => Readonly<{ x: number; y: number }>;
  setCurrent: (index: number) => SerializableState;
  centerCurrent: () => SerializableState;
  fitAll: () => SerializableState;
  replaceTopology: (removeSelected: boolean) => SerializableState;
  scopeMismatch: () => string;
  dispatchHistoryRoute: (route: 'map' | 'card') => SerializableState;
  logoutAndReenter: () => SerializableState;
  dispose: () => void;
}>;

declare global {
  interface Window {
    __fukamuFullNetworkCameraHarness: CameraHarness;
  }
}

const primaryScope: VaultNotesScope = {
  kind: 'vault',
  accountId: parseAccountId('01991f20-61d2-7000-8000-000000008101'),
  vaultId: parseVaultId('01991f20-61d2-7000-8000-000000008201'),
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000008301'),
  sessionEpoch: parseSessionEpoch(1),
};

const nextScope: VaultNotesScope = {
  ...primaryScope,
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000008302'),
  sessionEpoch: parseSessionEpoch(2),
};

const ids = Array.from({ length: 2_048 }, (_, index) =>
  fixtureCardId(`camera-browser-${index}`),
);

function cardId(index: number): CardId {
  const value = ids[index];
  if (!value) throw new Error(`Missing camera fixture card ${index}`);
  return value;
}

function createInput(
  excludedCardId: CardId | null = null,
): ConnectionsInputModel {
  const includedIds = ids.filter((value) => value !== excludedCardId);
  const included = new Set(includedIds);
  const currentCardId = includedIds[0];
  if (!currentCardId) throw new Error('Camera fixture must have a node');
  const edges: ConnectionsInputModel['edges'] = [];
  for (let index = 0; index < ids.length - 1; index += 1) {
    const sourceCardId = cardId(index);
    const targetCardId = cardId(index + 1);
    if (included.has(sourceCardId) && included.has(targetCardId)) {
      edges.push({
        sourceCardId,
        targetCardId,
        accessibleName: `${index} to ${index + 1}`,
      });
    }
  }
  return {
    currentCardId,
    nodes: includedIds.map((value, index) => ({
      cardId: value,
      displayLabel: `#${index + 1}`,
      title: `Camera card ${index + 1}`,
      accessibleName: `Camera card ${index + 1}`,
      current: value === currentCardId,
    })),
    edges,
  };
}

function createDataset(excludedCardId: CardId | null = null) {
  const topology = createFullNetworkTopology(createInput(excludedCardId));
  const layout = layoutFullNetworkTopology(topology);
  return createFullNetworkRenderDataset(
    createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    ),
  );
}

function createSurface(): HTMLDivElement {
  document
    .querySelector('[data-testid="full-network-camera-harness"]')
    ?.remove();
  const viewport = document.createElement('div');
  viewport.dataset.testid = 'full-network-camera-harness';
  viewport.tabIndex = 0;
  viewport.style.position = 'fixed';
  viewport.style.left = '10px';
  viewport.style.top = '10px';
  viewport.style.width = 'calc(100vw - 20px)';
  viewport.style.maxWidth = '640px';
  viewport.style.height = 'calc(100vh - 20px)';
  viewport.style.maxHeight = '420px';
  viewport.style.zIndex = '2147483647';
  viewport.style.touchAction = 'none';
  viewport.style.background = '#fbf7ef';
  document.body.appendChild(viewport);
  return viewport;
}

let viewport: HTMLDivElement | null = null;
let dataset: FullNetworkRenderDataset = createDataset();
let session: FullNetworkMapSession = createFullNetworkMapSession(primaryScope);
let scope = primaryScope;
let currentCardId: CardId = cardId(0);
let adapter: ReturnType<typeof createFullNetworkCameraAdapter> | null = null;
let openedCardId: CardId | null = null;
let route: 'map' | 'card' = 'map';

function activeViewport(): HTMLDivElement {
  if (!viewport) throw new Error('Camera harness is not initialized');
  return viewport;
}

function state(): SerializableState {
  const value = adapter?.getState();
  const stored = session.read();
  const camera = value?.camera ?? stored?.camera;
  if (!camera) throw new Error('Camera harness has no state');
  return {
    level:
      value?.level ??
      (camera.scale >= 6
        ? 'detail'
        : camera.scale >= 0.75
          ? 'network'
          : 'overview'),
    scale: camera.scale,
    offsetX: camera.offsetX,
    offsetY: camera.offsetY,
    currentCardId: value?.currentCardId ?? currentCardId,
    selectedCardId: value?.selectedCardId ?? stored?.selectedCardId ?? null,
    restoreReason: value?.restoreReason ?? 'exact',
    openedCardId,
    route,
  };
}

function updateDatasetAttributes(value: FullNetworkCameraAdapterState): void {
  const surface = activeViewport();
  surface.dataset.level = value.level;
  surface.dataset.scale = String(value.camera.scale);
  surface.dataset.currentCardId = value.currentCardId ?? '';
  surface.dataset.selectedCardId = value.selectedCardId ?? '';
  surface.dataset.restoreReason = value.restoreReason;
}

function mount(): void {
  adapter?.destroy();
  route = 'map';
  const surface = activeViewport();
  surface.style.display = 'block';
  adapter = createFullNetworkCameraAdapter({
    viewport: surface,
    scope,
    session,
    dataset,
    currentCardId,
    onChange: updateDatasetAttributes,
    onOpenCard: (nextCardId) => {
      openedCardId = nextCardId;
      adapter?.destroy();
      adapter = null;
      route = 'card';
      surface.style.display = 'none';
      history.pushState(
        { kind: 'camera-card' },
        '',
        `${location.pathname}${location.search}#camera-card-${nextCardId}`,
      );
    },
  });
}

window.addEventListener('popstate', (event) => {
  const candidate: unknown = event.state;
  if (
    location.hash === '#camera-map' ||
    (typeof candidate === 'object' &&
      candidate !== null &&
      'kind' in candidate &&
      candidate.kind === 'camera-map')
  ) {
    mount();
  } else {
    adapter?.destroy();
    adapter = null;
    route = 'card';
    if (viewport) viewport.style.display = 'none';
  }
});

window.__fukamuFullNetworkCameraHarness = {
  initialize(currentIndex = 0) {
    adapter?.destroy();
    viewport = createSurface();
    dataset = createDataset();
    scope = primaryScope;
    session = createFullNetworkMapSession(scope);
    currentCardId = cardId(currentIndex);
    openedCardId = null;
    history.replaceState(
      { kind: 'camera-map' },
      '',
      `${location.pathname}${location.search}#camera-map`,
    );
    mount();
    return state();
  },
  state,
  nodePoint(index) {
    const value = adapter?.getState();
    if (!value) throw new Error('Camera route is not mounted');
    const nodeIndex = dataset.nodeIndexesByCardId.get(cardId(index));
    if (nodeIndex === undefined)
      throw new Error(`Node ${index} is not present`);
    const x = dataset.routing.layout.x[nodeIndex];
    const y = dataset.routing.layout.y[nodeIndex];
    if (x === undefined || y === undefined)
      throw new Error('Node has no position');
    const bounds = activeViewport().getBoundingClientRect();
    return {
      x: bounds.left + value.camera.offsetX + x * value.camera.scale,
      y: bounds.top + value.camera.offsetY + y * value.camera.scale,
    };
  },
  setCurrent(index) {
    currentCardId = cardId(index);
    adapter?.setCurrentCardId(currentCardId);
    return state();
  },
  centerCurrent() {
    adapter?.centerCurrent();
    return state();
  },
  fitAll() {
    adapter?.fitAll();
    return state();
  },
  replaceTopology(removeSelected) {
    const selected = adapter?.getState().selectedCardId ?? null;
    dataset = createDataset(removeSelected ? selected : cardId(2_047));
    adapter?.replaceDataset(dataset, currentCardId);
    return state();
  },
  scopeMismatch() {
    try {
      createFullNetworkCameraAdapter({
        viewport: activeViewport(),
        scope: primaryScope,
        session: createFullNetworkMapSession(nextScope),
        dataset,
        currentCardId,
        onChange: () => undefined,
        onOpenCard: () => undefined,
      });
      return 'adapter accepted a mismatched scope';
    } catch (error: unknown) {
      return error instanceof Error ? error.message : 'unknown error';
    }
  },
  dispatchHistoryRoute(nextRoute) {
    const kind = nextRoute === 'map' ? 'camera-map' : 'camera-card';
    history.replaceState(
      { kind },
      '',
      `${location.pathname}${location.search}#${kind}`,
    );
    if (nextRoute === 'map') {
      mount();
    } else {
      adapter?.destroy();
      adapter = null;
      route = 'card';
      activeViewport().style.display = 'none';
    }
    return state();
  },
  logoutAndReenter() {
    adapter?.destroy();
    session.clear();
    scope = nextScope;
    session = createFullNetworkMapSession(scope);
    dataset = createDataset();
    currentCardId = cardId(0);
    openedCardId = null;
    mount();
    return state();
  },
  dispose() {
    adapter?.destroy();
    adapter = null;
    viewport?.remove();
    viewport = null;
  },
};
