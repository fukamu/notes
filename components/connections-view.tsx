'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LocateFixed,
  Maximize2,
  Minus,
  Move,
  Network,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import type { FullNetworkLayoutControllerState } from '@/lib/application/full-network-layout-controller';
import {
  createFullNetworkAccessibilityAdapter,
  type FullNetworkAccessibilityAdapter,
  type FullNetworkAccessibilityPreferences,
} from '@/lib/client/full-network-accessibility-adapter';
import {
  createFullNetworkCameraAdapter,
  type FullNetworkCameraAdapter,
  type FullNetworkCameraAdapterState,
} from '@/lib/client/full-network-camera-adapter';
import {
  createFullNetworkBrowserRenderer,
  darkFullNetworkRenderPalette,
  highContrastFullNetworkRenderPalette,
  lightFullNetworkRenderPalette,
  type FullNetworkBrowserRenderer,
  type FullNetworkRendererStatus,
  type FullNetworkVisibleNodeDetail,
} from '@/lib/client/full-network-renderer';
import {
  createFullNetworkAccessibilityIndex,
  type FullNetworkAvailabilityInput,
} from '@/lib/graph/full-network-accessibility';
import {
  defaultFullNetworkCameraConfiguration,
  fitFullNetworkCamera,
} from '@/lib/graph/full-network-camera';
import {
  createFullNetworkRenderDataset,
  createFullNetworkRenderPlan,
  type FullNetworkRenderDataset,
  type FullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';

type MapRuntime = Readonly<{
  accessibility: FullNetworkAccessibilityAdapter;
  camera: FullNetworkCameraAdapter;
  renderer: FullNetworkBrowserRenderer;
  dataset: FullNetworkRenderDataset;
  plan: () => FullNetworkRenderPlan;
  rendererStatus: () => FullNetworkRendererStatus;
}>;

function completeLayout(state: FullNetworkLayoutControllerState) {
  switch (state.status) {
    case 'ready':
    case 'refreshing':
      return state.ready;
    case 'error':
      return state.ready;
    case 'idle':
    case 'loading':
    case 'destroyed':
      return null;
  }
}

function layoutAvailability(
  state: FullNetworkLayoutControllerState,
): FullNetworkAvailabilityInput['layout'] {
  const hasCompleteLayout = completeLayout(state) !== null;
  if (state.status === 'error') {
    return {
      status: 'error',
      hasCompleteLayout,
      reason: state.reason,
    };
  }
  return { status: state.status, hasCompleteLayout };
}

function rendererAvailability(
  status: FullNetworkRendererStatus,
): FullNetworkAvailabilityInput['renderer'] {
  switch (status.kind) {
    case 'idle':
    case 'building':
    case 'ready':
    case 'disposed':
      return { status: status.kind };
    case 'context-lost':
      return { status: 'context-lost' };
    case 'error':
      return { status: 'error', message: status.message };
  }
}

function availability(
  state: FullNetworkLayoutControllerState,
  rendererStatus: FullNetworkRendererStatus,
): FullNetworkAvailabilityInput {
  return {
    layout: layoutAvailability(state),
    renderer: rendererAvailability(rendererStatus),
  };
}

function visibleDetails(
  plan: FullNetworkRenderPlan,
  state: NonNullable<ReturnType<typeof completeLayout>>,
): readonly FullNetworkVisibleNodeDetail[] {
  const details: FullNetworkVisibleNodeDetail[] = [];
  for (const nodeIndex of plan.visibleNodeIndexes) {
    const node = state.input.nodes[nodeIndex];
    if (!node) continue;
    details.push({
      nodeIndex,
      displayLabel: node.displayLabel,
      title: node.title,
    });
  }
  return details;
}

function palette(preferences: FullNetworkAccessibilityPreferences) {
  if (preferences.highContrast) return highContrastFullNetworkRenderPalette;
  return document.documentElement.classList.contains('dark')
    ? darkFullNetworkRenderPalette
    : lightFullNetworkRenderPalette;
}

export function ConnectionsView({
  state,
  actions,
  scope,
  session,
  retryLayout,
}: ConnectionsRendererProps) {
  const ready = completeLayout(state);
  const dataset = useMemo(() => {
    if (!ready) return null;
    return createFullNetworkRenderDataset(
      createFullNetworkRouting(
        ready.topology,
        ready.layout,
        ready.configuration,
      ),
    );
  }, [ready]);
  const accessibilityIndex = useMemo(
    () =>
      ready && dataset
        ? createFullNetworkAccessibilityIndex(ready.input, dataset)
        : null,
    [dataset, ready],
  );
  const viewportRef = useRef<HTMLElement>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const detailCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MapRuntime | null>(null);
  const stateRef = useRef(state);
  const openCardRef = useRef(actions.openCard);
  const retryLayoutRef = useRef(retryLayout);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [rendererStatus, setRendererStatus] =
    useState<FullNetworkRendererStatus>({ kind: 'idle' });
  const [semanticLevel, setSemanticLevel] = useState('overview');
  const [cameraScale, setCameraScale] = useState<number | null>(null);
  const [minimumCameraScale, setMinimumCameraScale] = useState<number | null>(
    null,
  );

  useEffect(() => {
    stateRef.current = state;
    openCardRef.current = actions.openCard;
    retryLayoutRef.current = retryLayout;
  }, [actions.openCard, retryLayout, state]);

  useEffect(() => {
    if (!ready || !dataset || !accessibilityIndex) return;
    const viewport = viewportRef.current;
    const overviewCanvas = overviewCanvasRef.current;
    const detailCanvas = detailCanvasRef.current;
    const overlay = overlayRef.current;
    const summary = summaryRef.current;
    const liveRegion = liveRef.current;
    const statusRegion = statusRef.current;
    if (
      !viewport ||
      !overviewCanvas ||
      !detailCanvas ||
      !overlay ||
      !summary ||
      !liveRegion ||
      !statusRegion
    ) {
      return;
    }

    let active = true;
    setRendererStatus({ kind: 'idle' });
    let currentRendererStatus: FullNetworkRendererStatus = { kind: 'idle' };
    let preferences: FullNetworkAccessibilityPreferences = {
      reducedMotion: false,
      highContrast: false,
    };
    let currentPlan: FullNetworkRenderPlan | null = null;
    let previousLevel: FullNetworkRenderPlan['level'] | undefined;
    let accessibility: FullNetworkAccessibilityAdapter | null = null;
    let cameraRenderCount = 0;
    let pendingCameraState: FullNetworkCameraAdapterState | null = null;
    let cameraFrame: number | null = null;

    const renderer = createFullNetworkBrowserRenderer({
      overviewCanvas,
      detailCanvas,
      onStatus: (next) => {
        currentRendererStatus = next;
        if (!active) return;
        setRendererStatus(next);
        if (accessibility && currentPlan) {
          accessibility.update({
            scope,
            index: accessibilityIndex,
            dataset,
            plan: currentPlan,
            availability: availability(stateRef.current, next),
          });
        }
      },
    });

    const renderCameraNow = (
      cameraState: FullNetworkCameraAdapterState,
    ): void => {
      currentPlan = createFullNetworkRenderPlan({
        dataset,
        camera: cameraState.camera,
        ...(previousLevel ? { previousLevel } : {}),
        currentCardId: cameraState.currentCardId,
        selectedCardId: cameraState.selectedCardId,
        reducedMotion: preferences.reducedMotion,
      });
      previousLevel = currentPlan.level;
      renderer.render(currentPlan, visibleDetails(currentPlan, ready));
      cameraRenderCount += 1;
      viewport.dataset.renderPlanKey = currentPlan.planKey;
      viewport.dataset.cameraX = String(cameraState.camera.offsetX);
      viewport.dataset.cameraY = String(cameraState.camera.offsetY);
      viewport.dataset.cameraRenderCount = String(cameraRenderCount);
      viewport.dataset.semanticLevel = currentPlan.level;
      viewport.dataset.visibleNodeCount = String(
        currentPlan.visibleNodeIndexes.length,
      );
      viewport.dataset.visibleEdgeCount = String(
        currentPlan.visibleEdgeIndexes.length,
      );
      setSemanticLevel(currentPlan.level);
      setCameraScale(cameraState.camera.scale);
      if (accessibility) {
        accessibility.update({
          scope,
          index: accessibilityIndex,
          dataset,
          plan: currentPlan,
          availability: availability(stateRef.current, currentRendererStatus),
        });
      }
    };
    const scheduleCameraRender = (
      cameraState: FullNetworkCameraAdapterState,
    ): void => {
      pendingCameraState = cameraState;
      if (!currentPlan) {
        pendingCameraState = null;
        renderCameraNow(cameraState);
        return;
      }
      if (cameraFrame !== null) return;
      cameraFrame = window.requestAnimationFrame(() => {
        cameraFrame = null;
        const next = pendingCameraState;
        pendingCameraState = null;
        if (active && next) renderCameraNow(next);
      });
    };

    const bounds = viewport.getBoundingClientRect();
    const width = Math.max(1, viewport.clientWidth || bounds.width);
    const height = Math.max(1, viewport.clientHeight || bounds.height);
    setMinimumCameraScale(fitFullNetworkCamera(dataset, width, height).scale);
    renderer.resize({
      width,
      height,
      devicePixelRatio: Math.max(1, window.devicePixelRatio),
    });
    renderer.replaceDataset(dataset);
    const camera = createFullNetworkCameraAdapter({
      viewport,
      scope,
      session,
      dataset,
      currentCardId: ready.input.currentCardId,
      onChange: scheduleCameraRender,
      onOpenCard: (cardId) => openCardRef.current(cardId),
    });
    if (!currentPlan) {
      camera.destroy();
      renderer.dispose();
      throw new Error('Full-network camera did not publish its initial plan');
    }
    accessibility = createFullNetworkAccessibilityAdapter({
      scope,
      region: viewport,
      overlay,
      summary,
      liveRegion,
      statusRegion,
      index: accessibilityIndex,
      dataset,
      plan: currentPlan,
      availability: availability(stateRef.current, currentRendererStatus),
      selectedCardId: camera.getState().selectedCardId,
      onSelectCard: camera.selectCard,
      onOpenCard: (cardId) => openCardRef.current(cardId),
      onRetry: () => {
        if (stateRef.current.status === 'error') retryLayoutRef.current();
        else setRendererGeneration((current) => current + 1);
      },
      onPreferences: (next) => {
        preferences = next;
        renderer.setPalette(palette(next));
        const nextCamera = pendingCameraState ?? camera.getState();
        pendingCameraState = null;
        if (cameraFrame !== null) window.cancelAnimationFrame(cameraFrame);
        cameraFrame = null;
        renderCameraNow(nextCamera);
      },
    });
    const runtime: MapRuntime = {
      accessibility,
      camera,
      renderer,
      dataset,
      plan: () => {
        if (!currentPlan) {
          throw new Error('Full-network render plan is unavailable');
        }
        return currentPlan;
      },
      rendererStatus: () => currentRendererStatus,
    };
    runtimeRef.current = runtime;

    const resize = (): void => {
      const nextBounds = viewport.getBoundingClientRect();
      const nextWidth = Math.max(1, viewport.clientWidth || nextBounds.width);
      const nextHeight = Math.max(
        1,
        viewport.clientHeight || nextBounds.height,
      );
      renderer.resize({
        width: nextWidth,
        height: nextHeight,
        devicePixelRatio: Math.max(1, window.devicePixelRatio),
      });
      setMinimumCameraScale(
        fitFullNetworkCamera(dataset, nextWidth, nextHeight).scale,
      );
      camera.resize(nextWidth, nextHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);

    return () => {
      active = false;
      observer.disconnect();
      if (cameraFrame !== null) window.cancelAnimationFrame(cameraFrame);
      cameraFrame = null;
      pendingCameraState = null;
      accessibility?.destroy();
      camera.destroy();
      renderer.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [accessibilityIndex, dataset, ready, rendererGeneration, scope, session]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !accessibilityIndex) return;
    runtime.accessibility.update({
      scope,
      index: accessibilityIndex,
      dataset: runtime.dataset,
      plan: runtime.plan(),
      availability: availability(state, runtime.rendererStatus()),
    });
  }, [accessibilityIndex, scope, state]);

  const nodeCount = ready?.input.nodes.length ?? 0;
  const edgeCount = ready?.input.edges.length ?? 0;
  const controlsDisabled = !ready;
  const zoomOutDisabled =
    controlsDisabled ||
    (cameraScale !== null &&
      minimumCameraScale !== null &&
      cameraScale <= minimumCameraScale + Number.EPSILON);
  const zoomInDisabled =
    controlsDisabled ||
    (cameraScale !== null &&
      cameraScale >=
        defaultFullNetworkCameraConfiguration.maximumScale - Number.EPSILON);

  return (
    <section className="w-full min-w-0" aria-labelledby="connections-heading">
      <div className="connections-map-heading mb-4">
        <div>
          <p className="eyebrow">FULL DIRECTED NETWORK</p>
          <h1
            id="connections-heading"
            className="font-heading text-2xl font-semibold"
          >
            つながり
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            全カードと全リンクを俯瞰し、拡大すると詳細を表示します。
            <Network aria-hidden="true" className="size-4 shrink-0" />
          </p>
        </div>
        <div
          className="connections-map-toolbar"
          role="toolbar"
          aria-label="つながりマップの表示操作"
        >
          <button
            type="button"
            className="connections-map-control"
            onClick={() => runtimeRef.current?.camera.fitAll()}
            disabled={controlsDisabled}
            aria-label="全体表示"
          >
            <Maximize2 aria-hidden="true" className="size-4" />
            <span>全体</span>
          </button>
          <button
            type="button"
            className="connections-map-control"
            onClick={() => runtimeRef.current?.camera.centerCurrent()}
            disabled={controlsDisabled || ready?.input.currentCardId === null}
            aria-label="現在のカードへ戻る"
          >
            <LocateFixed aria-hidden="true" className="size-4" />
            <span>現在地</span>
          </button>
          <button
            type="button"
            className="connections-map-control"
            onClick={() => runtimeRef.current?.accessibility.focus()}
            disabled={controlsDisabled}
            aria-label="キーボードでマップを操作"
            aria-describedby="connections-map-instructions"
          >
            <Move aria-hidden="true" className="size-4" />
            <span>操作</span>
          </button>
          <button
            type="button"
            className="connections-map-control connections-map-control-square"
            onClick={() => runtimeRef.current?.camera.zoomOut()}
            disabled={zoomOutDisabled}
            aria-label="縮小"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <output
            className="min-w-14 text-center font-mono text-xs text-muted-foreground"
            aria-label="現在のズーム"
            aria-live="polite"
          >
            {cameraScale === null ? '--' : `${Math.round(cameraScale * 100)}%`}
          </output>
          <button
            type="button"
            className="connections-map-control connections-map-control-square"
            onClick={() => runtimeRef.current?.camera.zoomIn()}
            disabled={zoomInDisabled}
            aria-label="拡大"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <p
        className="mb-4 text-xs text-muted-foreground"
        data-testid="connections-network-summary"
      >
        {ready
          ? `全${nodeCount.toLocaleString('ja-JP')}枚・全${edgeCount.toLocaleString('ja-JP')}本・${semanticLevel}`
          : 'つながりを準備しています'}
      </p>
      <p
        ref={summaryRef}
        id="full-network-accessibility-summary"
        className="sr-only"
        data-testid="connections-accessibility-summary"
      />
      <p
        ref={liveRef}
        className="sr-only"
        data-testid="connections-accessibility-selection"
      />
      <p id="connections-map-instructions" className="sr-only">
        ドラッグまたは一本指で移動、ピンチまたは Control
        キーを押しながらホイールで拡大縮小できます。矢印キーで移動、プラスとマイナスで拡大縮小、0で全体表示、Homeで現在のカードへ戻ります。Nでカード、Eでリンク、Lで隣接カード、Cで連結成分を順に確認できます。
      </p>

      <section
        ref={viewportRef}
        className="connections-viewport-structure connections-viewport"
        data-testid="connections-graph"
        data-layout-status={state.status}
        data-renderer-status={rendererStatus.kind}
        data-total-node-count={nodeCount}
        data-total-edge-count={edgeCount}
        data-camera-level={semanticLevel}
        data-active-pointers="0"
        data-dragging="false"
        data-click-suppression="false"
      >
        <canvas
          ref={overviewCanvasRef}
          className="connections-full-network-layer"
          data-testid="connections-overview-canvas"
          aria-hidden="true"
        />
        <canvas
          ref={detailCanvasRef}
          className="connections-full-network-layer"
          data-testid="connections-detail-canvas"
          aria-hidden="true"
        />
        <div
          ref={overlayRef}
          className="connections-full-network-overlay"
          data-testid="connections-accessibility-overlay"
        />
        <div
          ref={statusRef}
          className="connections-full-network-status"
          data-testid="connections-map-status"
        />
        {!ready && (
          <div
            className="connections-full-network-bootstrap-status"
            role={state.status === 'error' ? 'alert' : 'status'}
          >
            {state.status === 'error' ? (
              <>
                <TriangleAlert aria-hidden="true" className="size-5" />
                <span>つながりの配置を計算できませんでした。</span>
                <button type="button" onClick={retryLayout}>
                  再試行
                </button>
              </>
            ) : (
              <span>つながりを準備しています</span>
            )}
          </div>
        )}
      </section>

      {ready && edgeCount === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
