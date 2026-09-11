'use client';

import { ArrowRight, LoaderCircle, Network, TriangleAlert } from 'lucide-react';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { useConnectionsViewport } from '@/hooks/use-connections-viewport';
import type { ConnectionsLayoutSection } from '@/lib/graph/elk-layout';

function sectionPath(section: ConnectionsLayoutSection): string {
  const points = [section.startPoint, ...section.bendPoints, section.endPoint];
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

export function ConnectionsView({
  model,
  actions,
  presentation,
}: ConnectionsRendererProps) {
  const currentNode = model.status === 'ready' ? model.currentNode : null;
  const viewportRef = useConnectionsViewport(
    currentNode,
    presentation.viewportPadding,
  );

  return (
    <section
      className="mx-auto w-full max-w-5xl"
      aria-labelledby="connections-heading"
    >
      <div className="mb-5">
        <p className="eyebrow">ALL DIRECTED LINKS</p>
        <h1
          id="connections-heading"
          className="font-heading text-2xl font-semibold"
        >
          つながり
        </h1>
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          この端末にある全カードと、本文で明示した一方向リンクを表示します。
          <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
        </p>
      </div>

      <div
        ref={viewportRef}
        className="connections-viewport-structure connections-viewport"
        data-testid="connections-graph"
        data-layout-status={model.status}
        aria-busy={model.status === 'loading'}
        aria-label="全カード間の一方向リンク図。スクロールして全体を移動できます"
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
            className="connections-canvas-structure"
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

              {model.edges.map((edge) => (
                <g key={edge.id}>
                  <title>{edge.accessibleName}</title>
                  {edge.sections.map((section, sectionIndex) => {
                    const path = sectionPath(section);
                    const isLastSection =
                      sectionIndex === edge.sections.length - 1;
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
                            isLastSection
                              ? 'url(#connection-edge-arrow)'
                              : undefined
                          }
                        />
                      </g>
                    );
                  })}
                </g>
              ))}
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
      </div>

      {model.status === 'ready' && model.edges.length === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
