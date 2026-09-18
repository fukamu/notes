'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Network, TriangleAlert } from 'lucide-react';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { useConnectionsViewport } from '@/hooks/use-connections-viewport';
import type { CardId } from '@/lib/domain/id';
import { prepareConnectionsVisibility } from '@/lib/graph/connections-visibility';

export function ConnectionsView({
  model,
  totalNodeCount,
  totalEdgeCount,
  actions,
  presentation,
  cameraPosition,
}: ConnectionsRendererProps) {
  const openCard = actions.openCard;
  const readyModel = model.status === 'ready' ? model : null;
  const geometry = readyModel?.geometry ?? null;
  const edgeMaximumRadius = presentation.edgeMaximumRadius;
  const edgeNodeSpacing = presentation.layoutMetrics.edgeNodeSpacing;
  const preparedVisibility = useMemo(
    () =>
      geometry
        ? prepareConnectionsVisibility(
            geometry.nodes,
            geometry.edges,
            {
              x: 0,
              y: 0,
              width: geometry.width,
              height: geometry.height,
            },
            {
              maximumRadius: edgeMaximumRadius,
              nodeClearance: edgeNodeSpacing,
            },
          )
        : null,
    [edgeMaximumRadius, edgeNodeSpacing, geometry],
  );
  const [focusedCardId, setFocusedCardId] = useState<CardId | null>(null);
  const userActivityVersionRef = useRef(0);
  const focusedActivationRef = useRef<number | null>(null);
  const readyNodeIndexById = useMemo(
    () =>
      new Map(
        readyModel?.nodes.map((node, nodeIndex) => [node.cardId, nodeIndex]) ??
          [],
      ),
    [readyModel?.nodes],
  );
  const retainedNodeIndex = focusedCardId
    ? (readyNodeIndexById.get(focusedCardId) ?? null)
    : null;
  const {
    viewportRef,
    worldRef,
    edgeCanvasRef,
    cardCanvasRef,
    ensureNodeVisible,
    visibility,
    nodeRenderMode,
  } = useConnectionsViewport(
    readyModel,
    presentation.viewportPadding,
    preparedVisibility,
    retainedNodeIndex,
    openCard,
    cameraPosition,
  );
  const htmlNodeIndices = useMemo(() => {
    const indices =
      nodeRenderMode === 'html' ? [...(visibility?.nodeIndices ?? [])] : [];
    if (retainedNodeIndex !== null && !indices.includes(retainedNodeIndex)) {
      indices.push(retainedNodeIndex);
      indices.sort((left, right) => left - right);
    }
    return indices;
  }, [nodeRenderMode, retainedNodeIndex, visibility?.nodeIndices]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.dataset.mountedHtmlNodeCount = String(htmlNodeIndices.length);
    const requestedAt = Number(viewport.dataset.nodeRenderRequestedAt);
    if (Number.isFinite(requestedAt)) {
      viewport.dataset.nodeCommitDurationMs = String(
        performance.now() - requestedAt,
      );
    }
  }, [htmlNodeIndices, nodeRenderMode, viewportRef]);
  useLayoutEffect(() => {
    const recordActivity = () => {
      userActivityVersionRef.current += 1;
    };
    document.addEventListener('pointerdown', recordActivity, true);
    document.addEventListener('keydown', recordActivity, true);
    document.addEventListener('touchstart', recordActivity, true);
    return () => {
      document.removeEventListener('pointerdown', recordActivity, true);
      document.removeEventListener('keydown', recordActivity, true);
      document.removeEventListener('touchstart', recordActivity, true);
    };
  }, []);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      !readyModel ||
      !cameraPosition.restoreViewportFocus ||
      focusedActivationRef.current === cameraPosition.activationId
    ) {
      return;
    }
    const activationId = cameraPosition.activationId;
    const activityVersion = userActivityVersionRef.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (
        cancelled ||
        !cameraPosition.isActive() ||
        userActivityVersionRef.current !== activityVersion ||
        !viewport.isConnected
      ) {
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        active.isConnected
      ) {
        return;
      }
      focusedActivationRef.current = activationId;
      viewport.focus({ preventScroll: true });
    });
    return () => {
      cancelled = true;
    };
  }, [cameraPosition, readyModel, viewportRef]);
  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
      aria-label="つながり"
    >
      <p id="connections-map-instructions" className="sr-only">
        ドラッグまたは一本指で移動、ピンチまたは Control
        キーを押しながらホイールで拡大縮小できます。矢印キーで移動、プラスとマイナスで拡大縮小、0で全体表示、Homeで現在のカードへ戻ります。
      </p>

      <section
        ref={viewportRef}
        className="connections-viewport-structure connections-viewport"
        role="tabpanel"
        tabIndex={0}
        data-testid="connections-graph"
        data-layout-status={model.status}
        data-dragging="false"
        data-camera-render-count="0"
        data-active-pointers="0"
        data-click-suppression="false"
        data-navigation-entry-id={cameraPosition.entryId}
        data-navigation-activation-id={cameraPosition.activationId}
        data-total-node-count={totalNodeCount}
        data-total-edge-count={totalEdgeCount}
        data-visual-node-count={
          readyModel ? (visibility?.nodeIndices.length ?? 0) : 0
        }
        data-visual-edge-count={
          readyModel ? (visibility?.edgeIndices.length ?? 0) : 0
        }
        data-node-renderer={nodeRenderMode}
        data-mounted-html-node-count={htmlNodeIndices.length}
        aria-busy={model.status === 'loading'}
        aria-label="すべてのカードの一方向リンクマップ"
        aria-describedby="connections-map-instructions"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0 Home"
      >
        {model.status === 'loading' && (
          <output className="grid h-full min-h-0 place-items-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
              つながりを配置しています
            </span>
          </output>
        )}

        {model.status === 'error' && (
          <div className="h-full min-h-0 p-2" role="alert">
            <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <TriangleAlert aria-hidden="true" className="size-5" />
              配置を計算できませんでした。カードまたは過去のカードから別のカードへ移動できます。
            </p>
          </div>
        )}

        {model.status === 'ready' && (
          <canvas
            ref={edgeCanvasRef}
            className="connections-edge-canvas"
            data-testid="connections-edge-canvas"
            aria-hidden="true"
          />
        )}

        {model.status === 'ready' && (
          <canvas
            ref={cardCanvasRef}
            className="connections-card-canvas"
            data-testid="connections-card-canvas"
            aria-hidden="true"
          />
        )}

        {model.status === 'ready' && (
          <div
            ref={worldRef}
            className="connections-canvas-structure connections-world"
            style={{ width: model.width, height: model.height }}
            data-testid="connections-canvas"
            data-layout-key={model.layoutKey}
            data-layout-width={model.width}
            data-layout-height={model.height}
          >
            {htmlNodeIndices.map((nodeIndex) => {
              const node = model.nodes[nodeIndex];
              if (!node) return null;
              return (
                <button
                  key={node.cardId}
                  id={`connections-map-card-${node.cardId}`}
                  type="button"
                  onClick={() => openCard(node.cardId)}
                  aria-current={node.current ? 'true' : undefined}
                  aria-label={node.accessibleName}
                  className="connections-node-structure connections-node-shell connections-node"
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    height: node.height,
                  }}
                  data-card-id={node.cardId}
                  onFocus={() => {
                    setFocusedCardId(node.cardId);
                    ensureNodeVisible(node);
                  }}
                  onBlur={() => setFocusedCardId(null)}
                  draggable={false}
                >
                  <span className="font-mono text-[11px] font-semibold text-accent-foreground">
                    {node.displayLabel}
                  </span>
                  <span className="mt-1 block w-full truncate font-heading font-semibold">
                    {node.title}
                  </span>
                  {node.current && (
                    <span className="sr-only">現在のカード</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {model.status === 'ready' && model.edges.length === 0 && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex items-center gap-3 rounded-xl border border-dashed bg-card/90 px-4 py-3 text-sm text-muted-foreground backdrop-blur">
            <Network aria-hidden="true" className="size-5 shrink-0" />
            本文でカードをリンクすると、カード間の一方向リンクが現れます。
          </div>
        )}
      </section>
    </section>
  );
}
