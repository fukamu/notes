'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  LocateFixed,
  LoaderCircle,
  Maximize2,
  Minus,
  Move,
  Network,
  Plus,
  TriangleAlert,
} from 'lucide-react';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { ConnectionsSemanticLists } from '@/components/connections-semantic-lists';
import { useConnectionsViewport } from '@/hooks/use-connections-viewport';
import { prepareConnectionsVisibility } from '@/lib/graph/connections-visibility';

export function ConnectionsView({
  model,
  semanticInput,
  totalNodeCount,
  totalEdgeCount,
  actions,
  presentation,
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
  const [focusedCardId, setFocusedCardId] = useState<
    (typeof semanticInput.nodes)[number]['cardId'] | null
  >(null);
  const pendingMapFocusRef = useRef<
    (typeof semanticInput.nodes)[number]['cardId'] | null
  >(null);
  const readyNodesById = useMemo(
    () =>
      new Map(
        readyModel?.nodes.map((node, nodeIndex) => [
          node.cardId,
          { node, nodeIndex },
        ]) ?? [],
      ),
    [readyModel?.nodes],
  );
  const retainedNodeIndex = focusedCardId
    ? (readyNodesById.get(focusedCardId)?.nodeIndex ?? null)
    : null;
  const {
    viewportRef,
    worldRef,
    edgeCanvasRef,
    cardCanvasRef,
    zoomOutputRef,
    zoomInRef,
    zoomOutRef,
    keyboardRef,
    zoomIn,
    zoomOut,
    fit,
    centerCurrent,
    ensureNodeVisible,
    visibility,
    nodeRenderMode,
  } = useConnectionsViewport(
    readyModel,
    presentation.viewportPadding,
    preparedVisibility,
    retainedNodeIndex,
    openCard,
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
    const cardId = pendingMapFocusRef.current;
    if (!cardId || nodeRenderMode !== 'html') return;
    const target = document.getElementById(`connections-map-card-${cardId}`);
    if (!(target instanceof HTMLButtonElement)) return;
    pendingMapFocusRef.current = null;
    target.focus({ preventScroll: true });
  }, [htmlNodeIndices, nodeRenderMode]);
  const moveToMap = useCallback(
    (cardId: (typeof semanticInput.nodes)[number]['cardId']) => {
      const entry = readyNodesById.get(cardId);
      if (!entry) return;
      pendingMapFocusRef.current = cardId;
      setFocusedCardId(cardId);
      ensureNodeVisible(entry.node);
    },
    [ensureNodeVisible, readyNodesById],
  );

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
            すべてのカードと、その参照関係を表示します。
            <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
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
            onClick={fit}
            disabled={!readyModel}
            aria-label="全体表示"
          >
            <Maximize2 aria-hidden="true" className="size-4" />
            <span>全体</span>
          </button>
          <button
            type="button"
            className="connections-map-control"
            onClick={centerCurrent}
            disabled={!readyModel?.currentNode}
            aria-label="現在のカードへ戻る"
          >
            <LocateFixed aria-hidden="true" className="size-4" />
            <span>現在地</span>
          </button>
          <button
            ref={keyboardRef}
            type="button"
            className="connections-map-control"
            disabled={!readyModel}
            aria-label="キーボードでマップを操作"
            aria-describedby="connections-map-instructions"
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - 0 Home"
          >
            <Move aria-hidden="true" className="size-4" />
            <span>操作</span>
          </button>
          <button
            ref={zoomOutRef}
            type="button"
            className="connections-map-control connections-map-control-square"
            onClick={zoomOut}
            disabled={!readyModel}
            aria-label="縮小"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <output
            ref={zoomOutputRef}
            className="min-w-12 text-center font-mono text-xs text-muted-foreground"
            aria-label="現在のズーム"
            aria-live="polite"
          >
            --
          </output>
          <button
            ref={zoomInRef}
            type="button"
            className="connections-map-control connections-map-control-square"
            onClick={zoomIn}
            disabled={!readyModel}
            aria-label="拡大"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <p
        className="mb-4 text-xs text-muted-foreground"
        aria-live="polite"
        data-testid="connections-network-summary"
      >
        全{totalNodeCount.toLocaleString('ja-JP')}枚・
        {totalEdgeCount.toLocaleString('ja-JP')}参照
      </p>

      <ConnectionsSemanticLists
        input={semanticInput}
        canMoveToMap={readyModel !== null}
        openCard={openCard}
        moveToMap={moveToMap}
      />

      <p id="connections-map-instructions" className="sr-only">
        ドラッグまたは一本指で移動、ピンチまたは Control
        キーを押しながらホイールで拡大縮小できます。矢印キーで移動、プラスとマイナスで拡大縮小、0で全体表示、Homeで現在のカードへ戻ります。
      </p>

      <section
        ref={viewportRef}
        className="connections-viewport-structure connections-viewport"
        data-testid="connections-graph"
        data-layout-status={model.status}
        data-dragging="false"
        data-camera-render-count="0"
        data-active-pointers="0"
        data-click-suppression="false"
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
      >
        {model.status === 'loading' && (
          <output className="grid h-full min-h-64 place-items-center text-sm text-muted-foreground">
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
          <div className="min-h-64 p-2" role="alert">
            <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <TriangleAlert aria-hidden="true" className="size-5" />
              配置を計算できませんでした。上の「カードと参照の一覧」から全カードを検索して開けます。
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
                    pendingMapFocusRef.current = null;
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
      </section>

      {model.status === 'ready' && model.edges.length === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
