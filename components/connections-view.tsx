'use client';

import { memo, useMemo } from 'react';
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
    <section className="e2-connections" aria-labelledby="connections-heading">
      <div className="e2-connections-heading">
        <h1 id="connections-heading">つながり</h1>
        <p>
          この端末にある全カードと、本文で明示した一方向リンクを表示します。
        </p>
      </div>

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
        aria-busy={model.status === 'loading'}
        aria-label="全カード間の一方向リンクマップ"
        aria-describedby="connections-map-instructions"
      >
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
            全体
          </button>
          <button
            type="button"
            className="connections-map-control"
            onClick={centerCurrent}
            disabled={!readyModel?.currentNode}
            aria-label="現在のカードへ戻る"
          >
            現在地
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
            操作
          </button>
          <button
            ref={zoomOutRef}
            type="button"
            className="connections-map-control connections-map-control-square"
            onClick={zoomOut}
            disabled={!readyModel}
            aria-label="縮小"
          >
            −
          </button>
          <output
            ref={zoomOutputRef}
            className="e2-zoom-output"
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
            ＋
          </button>
        </div>

        {model.status === 'loading' && (
          <output className="e2-connections-state">
            つながりを配置しています
          </output>
        )}

        {model.status === 'error' && (
          <div className="e2-connections-error" role="alert">
            <p>配置を計算できませんでした。カードは一覧から開けます。</p>
            <div>
              {model.fallbackItems.map((item) => (
                <button
                  key={item.cardId}
                  type="button"
                  onClick={() => actions.openCard(item.cardId)}
                  aria-current={item.current ? 'true' : undefined}
                  aria-label={item.accessibleName}
                  className="e2-connections-fallback-card"
                >
                  <span className="e2-node-title">{item.title}</span>
                  <span className="e2-node-meta">{item.displayLabel}</span>
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
                <span className="e2-node-title">{node.title}</span>
                <span className="e2-node-meta">
                  {node.current && <span>現在 </span>}
                  {node.displayLabel}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {model.status === 'ready' && model.edges.length === 0 && (
        <div className="e2-connections-empty">
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
