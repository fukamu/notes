import {
  createFullNetworkBrowserRenderer,
  darkFullNetworkRenderPalette,
  type FullNetworkBrowserRenderer,
  type FullNetworkRendererSnapshot,
} from '@/lib/client/full-network-renderer';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
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

type HarnessResult = Readonly<{
  snapshot: FullNetworkRendererSnapshot;
  level: FullNetworkRenderPlan['level'];
  canvasDataLength: number;
  overviewTransform: string;
}>;

type CameraBurstResult = Readonly<{
  before: FullNetworkRendererSnapshot;
  after: FullNetworkRendererSnapshot;
  finalLevel: FullNetworkRenderPlan['level'];
  visibleNodeCount: number;
  visibleEdgeCount: number;
  overviewTransform: string;
  detailQuadraticCurveCount: number;
}>;

type RendererHarness = Readonly<{
  initialize: (
    preferredBackend: 'webgl2' | 'canvas2d',
  ) => Promise<HarnessResult>;
  cameraBurst: () => Promise<CameraBurstResult>;
  changeTheme: () => Promise<FullNetworkRendererSnapshot>;
  resize: () => Promise<
    Readonly<{
      before: FullNetworkRendererSnapshot;
      after: FullNetworkRendererSnapshot;
      backingWidth: number;
      backingHeight: number;
    }>
  >;
  rejectHiddenDetail: () => string;
  recoverContext: () => Promise<
    Readonly<{
      lost: FullNetworkRendererSnapshot;
      recovered: FullNetworkRendererSnapshot;
    }>
  >;
  dispose: () => FullNetworkRendererSnapshot;
}>;

declare global {
  interface Window {
    __fukamuFullNetworkRendererHarness: RendererHarness;
  }
}

type ActiveHarness = Readonly<{
  renderer: FullNetworkBrowserRenderer;
  dataset: FullNetworkRenderDataset;
  overviewCanvas: HTMLCanvasElement;
  detailCanvas: HTMLCanvasElement;
  width: number;
  height: number;
  detailQuadraticCurves: { value: number };
}>;

let active: ActiveHarness | null = null;

function activeHarness(): ActiveHarness {
  if (!active) throw new Error('Renderer harness is not initialized');
  return active;
}

function createInput(): ConnectionsInputModel {
  const nodeCount = 256;
  const linksPerNode = 80;
  const nodeIds = Array.from({ length: nodeCount }, (_, index) =>
    fixtureCardId(`renderer-browser-${index}`),
  );
  const nodes = nodeIds.map((cardId, index) => ({
    cardId,
    displayLabel: `#${index + 1}`,
    title: `Renderer card ${index + 1}`,
    accessibleName: `Renderer card ${index + 1}`,
    current: index === 0,
  }));
  const edges: ConnectionsInputModel['edges'] = [];
  for (let source = 0; source < nodeCount; source += 1) {
    const sourceCardId = nodeIds[source];
    if (!sourceCardId) throw new Error(`Missing source fixture ${source}`);
    for (let offset = 0; offset < linksPerNode; offset += 1) {
      const target = offset;
      const targetCardId = nodeIds[target];
      if (!targetCardId) throw new Error(`Missing target fixture ${target}`);
      edges.push({
        sourceCardId,
        targetCardId,
        accessibleName: `${source} to ${target}`,
      });
    }
  }
  const currentCardId = nodeIds[0];
  if (!currentCardId) throw new Error('Renderer fixture omitted current node');
  return { currentCardId, nodes, edges };
}

function createDataset(): FullNetworkRenderDataset {
  const topology = createFullNetworkTopology(createInput());
  const layout = layoutFullNetworkTopology(topology);
  const routing = createFullNetworkRouting(
    topology,
    layout,
    defaultFullNetworkLayoutConfiguration,
  );
  return createFullNetworkRenderDataset(routing);
}

function createSurface(): Readonly<{
  root: HTMLDivElement;
  overview: HTMLCanvasElement;
  detail: HTMLCanvasElement;
}> {
  document
    .querySelector('[data-testid="full-network-renderer-harness"]')
    ?.remove();
  const root = document.createElement('div');
  root.dataset.testid = 'full-network-renderer-harness';
  root.style.position = 'fixed';
  root.style.inset = '8px';
  root.style.zIndex = '2147483647';
  root.style.overflow = 'hidden';
  root.style.background = '#fbf7ef';
  const overview = document.createElement('canvas');
  overview.dataset.testid = 'full-network-overview-canvas';
  overview.style.position = 'absolute';
  overview.style.inset = '0';
  const detail = document.createElement('canvas');
  detail.dataset.testid = 'full-network-detail-canvas';
  detail.style.position = 'absolute';
  detail.style.inset = '0';
  detail.style.pointerEvents = 'none';
  root.appendChild(overview);
  root.appendChild(detail);
  document.body.appendChild(root);
  return { root, overview, detail };
}

async function nextFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

async function waitUntilReady(
  renderer: FullNetworkBrowserRenderer,
): Promise<FullNetworkRendererSnapshot> {
  for (let frame = 0; frame < 180; frame += 1) {
    const snapshot = renderer.snapshot();
    if (snapshot.status.kind === 'ready') return snapshot;
    if (snapshot.status.kind === 'error') {
      throw new Error(snapshot.status.message);
    }
    await nextFrames(1);
  }
  throw new Error('Renderer did not become ready');
}

function overviewPlan(
  dataset: FullNetworkRenderDataset,
  width: number,
  height: number,
): FullNetworkRenderPlan {
  const scale = 0.2;
  return createFullNetworkRenderPlan({
    dataset,
    camera: {
      offsetX: (width - dataset.routing.layout.width * scale) / 2,
      offsetY: (height - dataset.routing.layout.height * scale) / 2,
      scale,
      viewportWidth: width,
      viewportHeight: height,
    },
    currentCardId: dataset.routing.topology.nodeIds[0] ?? null,
    reducedMotion: false,
  });
}

function details(
  dataset: FullNetworkRenderDataset,
  plan: FullNetworkRenderPlan,
): readonly Readonly<{
  nodeIndex: number;
  displayLabel: string;
  title: string;
}>[] {
  return [...plan.visibleNodeIndexes].map((nodeIndex) => ({
    nodeIndex,
    displayLabel: `#${nodeIndex + 1}`,
    title: `Renderer card ${nodeIndex + 1}`,
  }));
}

window.__fukamuFullNetworkRendererHarness = {
  async initialize(preferredBackend) {
    active?.renderer.dispose();
    const { root, overview, detail } = createSurface();
    const detailContext = detail.getContext('2d');
    if (!detailContext) throw new Error('Detail Canvas2D is unavailable');
    const detailQuadraticCurves = { value: 0 };
    const quadraticCurveTo = detailContext.quadraticCurveTo.bind(detailContext);
    detailContext.quadraticCurveTo = (...parameters) => {
      detailQuadraticCurves.value += 1;
      quadraticCurveTo(...parameters);
    };
    const width = Math.max(320, root.clientWidth);
    const height = Math.max(240, root.clientHeight);
    const dataset = createDataset();
    const renderer = createFullNetworkBrowserRenderer({
      overviewCanvas: overview,
      detailCanvas: detail,
      preferredBackend,
    });
    renderer.resize({
      width,
      height,
      devicePixelRatio: window.devicePixelRatio,
    });
    renderer.replaceDataset(dataset);
    const plan = overviewPlan(dataset, width, height);
    renderer.render(plan);
    active = {
      renderer,
      dataset,
      overviewCanvas: overview,
      detailCanvas: detail,
      width,
      height,
      detailQuadraticCurves,
    };
    const snapshot = await waitUntilReady(renderer);
    await nextFrames(2);
    return {
      snapshot,
      level: plan.level,
      canvasDataLength: overview.toDataURL().length,
      overviewTransform: overview.style.transform,
    };
  },
  async cameraBurst() {
    const state = activeHarness();
    const before = state.renderer.snapshot();
    let previousLevel: FullNetworkRenderPlan['level'] = 'overview';
    let finalPlan = overviewPlan(state.dataset, state.width, state.height);
    const nodeX = state.dataset.routing.layout.x[0] ?? 0;
    const nodeY = state.dataset.routing.layout.y[0] ?? 0;
    for (let step = 0; step < 20; step += 1) {
      finalPlan = createFullNetworkRenderPlan({
        dataset: state.dataset,
        camera: {
          offsetX: state.width / 2 - nodeX * 8 + step,
          offsetY: state.height / 2 - nodeY * 8,
          scale: 8,
          viewportWidth: state.width,
          viewportHeight: state.height,
        },
        previousLevel,
        currentCardId: state.dataset.routing.topology.nodeIds[0] ?? null,
        selectedCardId: state.dataset.routing.topology.nodeIds[1] ?? null,
        reducedMotion: false,
      });
      previousLevel = finalPlan.level;
      state.renderer.render(finalPlan, details(state.dataset, finalPlan));
    }
    await nextFrames(2);
    return {
      before,
      after: state.renderer.snapshot(),
      finalLevel: finalPlan.level,
      visibleNodeCount: finalPlan.visibleNodeIndexes.length,
      visibleEdgeCount: finalPlan.visibleEdgeIndexes.length,
      overviewTransform: state.overviewCanvas.style.transform,
      detailQuadraticCurveCount: state.detailQuadraticCurves.value,
    };
  },
  async changeTheme() {
    const state = activeHarness();
    state.renderer.setPalette(darkFullNetworkRenderPalette);
    await waitUntilReady(state.renderer);
    await nextFrames(2);
    return state.renderer.snapshot();
  },
  async resize() {
    const state = activeHarness();
    const before = state.renderer.snapshot();
    state.renderer.resize({
      width: Math.max(300, state.width - 24),
      height: Math.max(220, state.height - 16),
      devicePixelRatio: window.devicePixelRatio,
    });
    await waitUntilReady(state.renderer);
    await nextFrames(2);
    return {
      before,
      after: state.renderer.snapshot(),
      backingWidth: state.overviewCanvas.width,
      backingHeight: state.overviewCanvas.height,
    };
  },
  rejectHiddenDetail() {
    const state = activeHarness();
    const plan = overviewPlan(state.dataset, state.width, state.height);
    try {
      state.renderer.render(plan, [
        { nodeIndex: 0, displayLabel: '#1', title: 'Hidden title' },
      ]);
      return 'renderer accepted hidden detail';
    } catch (error: unknown) {
      return error instanceof Error ? error.message : 'unknown rejection';
    }
  },
  async recoverContext() {
    const state = activeHarness();
    if (state.renderer.snapshot().backend !== 'webgl2') {
      throw new Error('Context recovery requires WebGL2');
    }
    state.overviewCanvas.dispatchEvent(
      new Event('webglcontextlost', { cancelable: true }),
    );
    const lost = state.renderer.snapshot();
    state.overviewCanvas.dispatchEvent(new Event('webglcontextrestored'));
    const recovered = await waitUntilReady(state.renderer);
    await nextFrames(2);
    return { lost, recovered };
  },
  dispose() {
    const state = activeHarness();
    state.renderer.dispose();
    const snapshot = state.renderer.snapshot();
    active = null;
    return snapshot;
  },
};
