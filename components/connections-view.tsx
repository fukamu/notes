'use client';

import { memo, useMemo } from 'react';
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
import { useConnectionsViewport } from '@/hooks/use-connections-viewport';
import type { ConnectionsReadyEdge } from '@/lib/graph/connections-contract';
import { createConnectionsSvgPath } from '@/lib/graph/connections-path';

type ConnectionsEdgeLayerProps = {
  layoutKey: string;
  edges: ConnectionsReadyEdge[];
  maximumRadius: number;
  nodeClearance: number;
};

const ConnectionsEdgeLayer = memo(
  function ConnectionsEdgeLayer({
    edges,
    maximumRadius,
    nodeClearance,
  }: ConnectionsEdgeLayerProps) {
    const paths = useMemo(
      () =>
        edges.map((edge) =>
          edge.sections.map(
            (section) =>
              createConnectionsSvgPath(section, {
                maximumRadius,
                nodeClearance,
              }).d,
          ),
        ),
      [edges, maximumRadius, nodeClearance],
    );
    return edges.map((edge, edgeIndex) => (
      <g key={edge.id}>
        {edge.sections.map((section, sectionIndex) => {
          const path = paths[edgeIndex]?.[sectionIndex];
          if (!path) return null;
          const isLastSection = sectionIndex === edge.sections.length - 1;
          return (
            <g key={section.id}>
              <path
                d={path}
                fill="none"
                stroke="var(--card)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              />
              <path
                d={path}
                fill="none"
                stroke="var(--primary)"
                strokeOpacity="0.72"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={
                  isLastSection ? 'url(#connection-edge-arrow)' : undefined
                }
              />
            </g>
          );
        })}
      </g>
    ));
  },
  (previous, next) =>
    previous.layoutKey === next.layoutKey &&
    previous.maximumRadius === next.maximumRadius &&
    previous.nodeClearance === next.nodeClearance,
);

export function ConnectionsView({
  model,
  staging,
  actions,
  presentation,
}: ConnectionsRendererProps) {
  const readyModel = model.status === 'ready' ? model : null;
  const {
    viewportRef,
    worldRef,
    zoomOutputRef,
    zoomInRef,
    zoomOutRef,
    keyboardRef,
    zoomIn,
    zoomOut,
    fit,
    centerCurrent,
    ensureNodeVisible,
  } = useConnectionsViewport(readyModel, presentation.viewportPadding);

  return (
    <section className="w-full min-w-0" aria-labelledby="connections-heading">
      <div className="connections-map-heading mb-4">
        <div>
          <p className="eyebrow">FOCUSED DIRECTED LINKS</p>
          <h1
            id="connections-heading"
            className="font-heading text-2xl font-semibold"
          >
            つながり
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            現在のカードの周辺を、段階的に表示します。
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
        data-testid="connections-stage-summary"
      >
        全{staging.totalNodeCount.toLocaleString('ja-JP')}枚のうち
        {staging.visibleNodeCount.toLocaleString('ja-JP')}枚を表示
        {staging.focusLabel ? `・起点: ${staging.focusLabel}` : ''}
      </p>

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
        data-total-node-count={staging.totalNodeCount}
        data-visible-node-count={staging.visibleNodeCount}
        data-node-limit={staging.nodeLimit}
        data-stage-focus-id={staging.focusCardId ?? ''}
        aria-busy={model.status === 'loading'}
        aria-label="現在のカード周辺の一方向リンクマップ"
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
              配置を計算できませんでした。カードは一覧から開けます。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {model.fallbackItems.map((item) => (
                <button
                  key={item.cardId}
                  type="button"
                  onClick={() => actions.openCard(item.cardId)}
                  aria-current={item.current ? 'true' : undefined}
                  aria-label={item.accessibleName}
                  className="rounded-xl border bg-card px-4 py-3 text-left shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono text-[11px] font-semibold text-accent-foreground">
                    {item.displayLabel}
                  </span>
                  <span className="mt-1 block truncate font-heading font-semibold">
                    {item.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {model.status === 'ready' && (
          <div
            ref={worldRef}
            className="connections-canvas-structure connections-world"
            style={{ width: model.width, height: model.height }}
            data-testid="connections-canvas"
            data-layout-width={model.width}
            data-layout-height={model.height}
          >
            <svg
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={model.width}
              height={model.height}
              viewBox={`0 0 ${model.width} ${model.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="connection-edge-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                  markerUnits="strokeWidth"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
                </marker>
              </defs>

              <ConnectionsEdgeLayer
                layoutKey={model.layoutKey}
                edges={model.edges}
                maximumRadius={presentation.edgeMaximumRadius}
                nodeClearance={presentation.layoutMetrics.edgeNodeSpacing}
              />
            </svg>

            <ul className="sr-only" aria-label="カード間の一方向リンク一覧">
              {model.edges.map((edge) => (
                <li key={`accessible-${edge.id}`}>{edge.accessibleName}</li>
              ))}
            </ul>

            {model.nodes.map((node) => (
              <button
                key={node.cardId}
                type="button"
                onClick={() => actions.openCard(node.cardId)}
                aria-current={node.current ? 'true' : undefined}
                aria-label={node.accessibleName}
                className="connections-node-structure connections-node"
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                }}
                data-card-id={node.cardId}
                onFocus={() => ensureNodeVisible(node)}
                draggable={false}
              >
                <span className="font-mono text-[11px] font-semibold text-accent-foreground">
                  {node.displayLabel}
                </span>
                <span className="mt-1 block w-full truncate font-heading font-semibold">
                  {node.title}
                </span>
                {node.current && <span className="sr-only">現在のカード</span>}
              </button>
            ))}
          </div>
        )}
      </section>

      {staging.canExpand && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            className="connections-map-control"
            onClick={actions.expand}
            data-testid="connections-expand"
          >
            <Plus aria-hidden="true" className="size-4" />
            さらに
            {staging.nextExpansionCount.toLocaleString('ja-JP')}
            枚を表示
          </button>
        </div>
      )}

      {staging.stoppedAtMaximum && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          一度に表示できる上限に達しました。別のカードを開くと、そのカードの周辺を表示できます。
        </p>
      )}

      {model.status === 'ready' && model.edges.length === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
