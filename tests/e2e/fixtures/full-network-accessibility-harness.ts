import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  createFullNetworkAccessibilityAdapter,
  type FullNetworkAccessibilityAdapter,
} from '@/lib/client/full-network-accessibility-adapter';
import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
} from '@/lib/domain/identity';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkAccessibilityIndex,
  type FullNetworkAvailabilityInput,
} from '@/lib/graph/full-network-accessibility';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  createFullNetworkRenderDataset,
  createFullNetworkRenderPlan,
  type FullNetworkRenderDataset,
  type FullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { fixtureCardId } from '@/tests/fixtures/ids';

type FailureKind =
  | 'worker-stale'
  | 'invalid-response'
  | 'context-lost'
  | 'allocation-failure'
  | 'loading';

type HarnessState = Readonly<{
  nodeCount: number;
  edgeCount: number;
  overlayCount: number;
  regionRole: string | null;
  regionName: string | null;
  summary: string;
  selection: string;
  selectedCardId: CardId | null;
  openedCardId: CardId | null;
  retryCount: number;
  retryDisabled: boolean;
  statusRole: string | null;
  statusText: string;
  reducedMotion: boolean;
  highContrast: boolean;
}>;

type AccessibilityHarness = Readonly<{
  initialize: (nodeCount?: number) => HarnessState;
  state: () => HarnessState;
  fail: (kind: FailureKind) => HarnessState;
  scopeMismatch: () => string;
  destroy: () => HarnessState;
  reenter: () => HarnessState;
}>;

declare global {
  interface Window {
    __fukamuFullNetworkAccessibilityHarness: AccessibilityHarness;
  }
}

const primaryScope: VaultNotesScope = {
  kind: 'vault',
  accountId: parseAccountId('01991f20-61d2-7000-8000-000000009401'),
  vaultId: parseVaultId('01991f20-61d2-7000-8000-000000009501'),
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000009601'),
  sessionEpoch: parseSessionEpoch(1),
};

const nextScope: VaultNotesScope = {
  ...primaryScope,
  vaultId: parseVaultId('01991f20-61d2-7000-8000-000000009502'),
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000009602'),
  sessionEpoch: parseSessionEpoch(2),
};

type HarnessElements = Readonly<{
  root: HTMLElement;
  region: HTMLElement;
  overlay: HTMLElement;
  summary: HTMLElement;
  liveRegion: HTMLElement;
  statusRegion: HTMLElement;
}>;

function createElements(): HarnessElements {
  document
    .querySelector('[data-testid="full-network-accessibility-harness"]')
    ?.remove();
  const root = document.createElement('section');
  root.dataset.testid = 'full-network-accessibility-harness';
  root.style.position = 'fixed';
  root.style.inset = '8px';
  root.style.zIndex = '2147483647';
  root.style.background = '#fbf7ef';
  root.style.color = '#302b26';
  const region = document.createElement('div');
  region.dataset.testid = 'full-network-accessibility-region';
  region.style.position = 'relative';
  region.style.width = '640px';
  region.style.maxWidth = 'calc(100vw - 32px)';
  region.style.height = '420px';
  region.style.maxHeight = 'calc(100vh - 120px)';
  region.style.border = '1px solid #315f77';
  const overlay = document.createElement('div');
  overlay.dataset.testid = 'full-network-accessibility-overlay';
  const summary = document.createElement('p');
  summary.dataset.testid = 'full-network-accessibility-summary';
  const liveRegion = document.createElement('p');
  liveRegion.dataset.testid = 'full-network-accessibility-live';
  const statusRegion = document.createElement('div');
  statusRegion.dataset.testid = 'full-network-accessibility-status';
  region.appendChild(overlay);
  root.appendChild(region);
  root.appendChild(summary);
  root.appendChild(liveRegion);
  root.appendChild(statusRegion);
  document.body.appendChild(root);
  return { root, region, overlay, summary, liveRegion, statusRegion };
}

function createGraph(nodeCount: number, prefix: string) {
  const ids = Array.from({ length: nodeCount }, (_, index) =>
    fixtureCardId(`${prefix}-${nodeCount}-${index}`),
  );
  const id = (index: number): CardId => {
    const value = ids[index];
    if (!value) throw new Error(`Missing accessibility card ${index}`);
    return value;
  };
  const input: ConnectionsInputModel = {
    currentCardId: id(0),
    nodes: ids.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `${prefix} card ${index + 1}`,
      accessibleName: `${prefix} card ${index + 1}`,
      current: index === 0,
    })),
    edges: Array.from({ length: Math.max(0, nodeCount - 1) }, (_, index) => ({
      sourceCardId: id(index),
      targetCardId: id(index + 1),
      accessibleName: `${prefix} link ${index + 1}`,
    })),
  };
  const topology = createFullNetworkTopology(input);
  const layout = layoutFullNetworkTopology(topology);
  const dataset = createFullNetworkRenderDataset(
    createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    ),
  );
  const firstX = dataset.routing.layout.x[0];
  const firstY = dataset.routing.layout.y[0];
  if (firstX === undefined || firstY === undefined) {
    throw new Error('Accessibility graph requires one positioned card');
  }
  const plan = createFullNetworkRenderPlan({
    dataset,
    camera: {
      offsetX: 320 - firstX * 6,
      offsetY: 210 - firstY * 6,
      scale: 6,
      viewportWidth: 640,
      viewportHeight: 420,
    },
    currentCardId: id(0),
    selectedCardId: null,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  return {
    input,
    dataset,
    plan,
    index: createFullNetworkAccessibilityIndex(input, dataset),
  };
}

let elements: HarnessElements | null = null;
let adapter: FullNetworkAccessibilityAdapter | null = null;
let scope = primaryScope;
let dataset: FullNetworkRenderDataset | null = null;
let plan: FullNetworkRenderPlan | null = null;
let graph: ReturnType<typeof createGraph> | null = null;
let availability: FullNetworkAvailabilityInput = {
  layout: { status: 'ready', hasCompleteLayout: true },
  renderer: { status: 'ready' },
};
let selectedCardId: CardId | null = null;
let openedCardId: CardId | null = null;
let retryCount = 0;

function activeElements(): HarnessElements {
  if (!elements) throw new Error('Accessibility harness is not initialized');
  return elements;
}

function activeGraph(): ReturnType<typeof createGraph> {
  if (!graph) throw new Error('Accessibility graph is not initialized');
  return graph;
}

function activeDataset(): FullNetworkRenderDataset {
  if (!dataset) throw new Error('Accessibility dataset is not initialized');
  return dataset;
}

function activePlan(): FullNetworkRenderPlan {
  if (!plan) throw new Error('Accessibility plan is not initialized');
  return plan;
}

function state(): HarnessState {
  const view = activeElements();
  const current = adapter?.getState();
  const retry = view.statusRegion.querySelector('button');
  return {
    nodeCount: activeGraph().input.nodes.length,
    edgeCount: activeGraph().input.edges.length,
    overlayCount: view.overlay.childElementCount,
    regionRole: view.region.getAttribute('role'),
    regionName: view.region.getAttribute('aria-label'),
    summary: view.summary.textContent ?? '',
    selection: view.liveRegion.textContent ?? '',
    selectedCardId,
    openedCardId,
    retryCount,
    retryDisabled: retry instanceof HTMLButtonElement && retry.disabled,
    statusRole: view.statusRegion.getAttribute('role'),
    statusText: view.statusRegion.textContent ?? '',
    reducedMotion: current?.preferences.reducedMotion ?? false,
    highContrast: current?.preferences.highContrast ?? false,
  };
}

function mount(): void {
  const view = activeElements();
  const value = activeGraph();
  adapter = createFullNetworkAccessibilityAdapter({
    scope,
    region: view.region,
    overlay: view.overlay,
    summary: view.summary,
    liveRegion: view.liveRegion,
    statusRegion: view.statusRegion,
    index: value.index,
    dataset: activeDataset(),
    plan: activePlan(),
    availability,
    selectedCardId,
    onSelectCard: (cardId) => {
      selectedCardId = cardId;
    },
    onOpenCard: (cardId) => {
      openedCardId = cardId;
    },
    onRetry: () => {
      retryCount += 1;
    },
    onPreferences: () => undefined,
  });
}

function update(next: FullNetworkAvailabilityInput): HarnessState {
  availability = next;
  const value = activeGraph();
  adapter?.update({
    scope,
    index: value.index,
    dataset: activeDataset(),
    plan: activePlan(),
    availability,
  });
  return state();
}

window.__fukamuFullNetworkAccessibilityHarness = {
  initialize(nodeCount = 10_000) {
    adapter?.destroy();
    elements = createElements();
    scope = primaryScope;
    graph = createGraph(nodeCount, 'Primary vault');
    dataset = graph.dataset;
    plan = graph.plan;
    availability = {
      layout: { status: 'ready', hasCompleteLayout: true },
      renderer: { status: 'ready' },
    };
    selectedCardId = null;
    openedCardId = null;
    retryCount = 0;
    mount();
    return state();
  },
  state,
  fail(kind) {
    switch (kind) {
      case 'worker-stale':
        return update({
          layout: {
            status: 'error',
            hasCompleteLayout: true,
            reason: 'worker-failure',
          },
          renderer: { status: 'ready' },
        });
      case 'invalid-response':
        return update({
          layout: {
            status: 'error',
            hasCompleteLayout: false,
            reason: 'invalid-response',
          },
          renderer: { status: 'idle' },
        });
      case 'context-lost':
        return update({
          layout: { status: 'ready', hasCompleteLayout: true },
          renderer: { status: 'context-lost' },
        });
      case 'allocation-failure':
        return update({
          layout: { status: 'ready', hasCompleteLayout: true },
          renderer: {
            status: 'error',
            message: 'WebGL could not allocate a buffer',
          },
        });
      case 'loading':
        return update({
          layout: { status: 'loading', hasCompleteLayout: false },
          renderer: { status: 'building' },
        });
    }
  },
  scopeMismatch() {
    try {
      const value = activeGraph();
      adapter?.update({
        scope: nextScope,
        index: value.index,
        dataset: activeDataset(),
        plan: activePlan(),
        availability,
      });
      return 'adapter accepted mismatched scope';
    } catch (error: unknown) {
      return error instanceof Error ? error.message : 'unknown error';
    }
  },
  destroy() {
    adapter?.destroy();
    adapter = null;
    return state();
  },
  reenter() {
    adapter?.destroy();
    scope = nextScope;
    graph = createGraph(64, 'Next vault');
    dataset = graph.dataset;
    plan = graph.plan;
    availability = {
      layout: { status: 'ready', hasCompleteLayout: true },
      renderer: { status: 'ready' },
    };
    selectedCardId = null;
    openedCardId = null;
    retryCount = 0;
    mount();
    return state();
  },
};
