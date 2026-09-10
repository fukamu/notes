'use client';

import { ArrowRight, LoaderCircle, Network, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import { formatDisplayId } from '@/lib/domain/display-id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';
import {
  layoutConnectionsGraph,
  sectionPath,
  type ConnectionsLayout,
} from '@/lib/graph/elk-layout';

type Props = {
  cards: CardRecord[];
  currentCardId: string;
  onSelect: (cardId: string) => void;
};

function cardLabel(card: CardRecord, isCurrent: boolean): string {
  const base = `${formatDisplayId(card.displayId)} ${visibleTitle(card.title)}`;
  return isCurrent ? `${base}、現在のカード` : base;
}

export function ConnectionsView({ cards, currentCardId, onSelect }: Props) {
  const graph = useMemo(() => buildConnectionsGraph(cards), [cards]);
  const graphKey = useMemo(
    () =>
      JSON.stringify({
        nodes: graph.nodes.map((node) => node.card.id),
        edges: graph.edges,
      }),
    [graph],
  );
  const [layoutResult, setLayoutResult] = useState<{
    key: string;
    layout: ConnectionsLayout | null;
    failed: boolean;
  } | null>(null);
  const layoutRequestRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const centeredCardIdRef = useRef<string | null>(null);
  const layout = layoutResult?.key === graphKey ? layoutResult.layout : null;
  const layoutError = layoutResult?.key === graphKey && layoutResult.failed;

  useEffect(() => {
    const request = ++layoutRequestRef.current;
    let active = true;

    void layoutConnectionsGraph(graph)
      .then((nextLayout) => {
        if (!active || request !== layoutRequestRef.current) return;
        setLayoutResult({ key: graphKey, layout: nextLayout, failed: false });
      })
      .catch((error) => {
        console.error(error);
        if (!active || request !== layoutRequestRef.current) return;
        setLayoutResult({ key: graphKey, layout: null, failed: true });
      });

    return () => {
      active = false;
    };
  }, [graph, graphKey]);

  useEffect(() => {
    if (!layout || centeredCardIdRef.current === currentCardId) return;
    const viewport = viewportRef.current;
    const currentNode = layout.nodes.find((node) => node.id === currentCardId);
    if (!viewport || !currentNode) return;

    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTo({
        left: Math.max(
          0,
          currentNode.x + currentNode.width / 2 - viewport.clientWidth / 2,
        ),
        top: Math.max(
          0,
          currentNode.y + currentNode.height / 2 - viewport.clientHeight / 2,
        ),
        behavior: 'auto',
      });
      centeredCardIdRef.current = currentCardId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentCardId, layout]);

  const cardsById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );
  const nodesById = useMemo(
    () => new Map((layout?.nodes ?? []).map((node) => [node.id, node])),
    [layout],
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
        className="relative h-[60dvh] min-h-80 touch-pan-x touch-pan-y overflow-auto overscroll-contain rounded-2xl border bg-card/55 p-4 shadow-sm sm:h-[min(70dvh,640px)] sm:min-h-96"
        data-testid="connections-graph"
        data-layout-status={
          layoutError ? 'failed' : layout ? 'ready' : 'loading'
        }
        aria-busy={!layout && !layoutError}
        aria-label="全カード間の一方向リンク図。スクロールして全体を移動できます"
      >
        {!layout && !layoutError && (
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

        {layoutError && (
          <div className="min-h-64 p-2" role="alert">
            <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
              <TriangleAlert aria-hidden="true" className="size-5" />
              配置を計算できませんでした。カードは一覧から開けます。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {graph.nodes.map(({ card }) => {
                const isCurrent = card.id === currentCardId;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => onSelect(card.id)}
                    aria-current={isCurrent ? 'true' : undefined}
                    className="rounded-xl border bg-card px-4 py-3 text-left shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-mono text-[11px] font-semibold text-accent-foreground">
                      {formatDisplayId(card.displayId)}
                    </span>
                    <span className="mt-1 block truncate font-heading font-semibold">
                      {visibleTitle(card.title)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {layout && (
          <div
            className="relative"
            style={{
              width: layout.width,
              height: layout.height,
              minWidth: '100%',
              minHeight: '100%',
            }}
            data-testid="connections-canvas"
            data-layout-width={layout.width}
            data-layout-height={layout.height}
          >
            <svg
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
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

              {layout.edges.map((edge) => {
                const source = cardsById.get(edge.sourceCardId);
                const target = cardsById.get(edge.targetCardId);
                return (
                  <g
                    key={edge.id}
                    data-testid="connection-edge"
                    data-edge-id={edge.id}
                    data-source={edge.sourceCardId}
                    data-target={edge.targetCardId}
                    data-source-port={edge.sourcePortId}
                    data-target-port={edge.targetPortId}
                  >
                    <title>
                      {source ? visibleTitle(source.title) : edge.sourceCardId}{' '}
                      から{' '}
                      {target ? visibleTitle(target.title) : edge.targetCardId}{' '}
                      へのリンク
                    </title>
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
                            data-testid="connection-edge-section"
                            data-section-id={section.id}
                            data-incoming-shape={section.incomingShape}
                            data-outgoing-shape={section.outgoingShape}
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>

            <ul className="sr-only" aria-label="カード間の一方向リンク一覧">
              {layout.edges.map((edge) => {
                const source = cardsById.get(edge.sourceCardId);
                const target = cardsById.get(edge.targetCardId);
                return (
                  <li key={`accessible-${edge.id}`}>
                    {source ? visibleTitle(source.title) : edge.sourceCardId}{' '}
                    から{' '}
                    {target ? visibleTitle(target.title) : edge.targetCardId}{' '}
                    へのリンク
                  </li>
                );
              })}
            </ul>

            {graph.nodes.map(({ card }) => {
              const node = nodesById.get(card.id);
              if (!node) return null;
              const isCurrent = card.id === currentCardId;
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onSelect(card.id)}
                  aria-current={isCurrent ? 'true' : undefined}
                  aria-label={cardLabel(card, isCurrent)}
                  className="absolute z-10 flex flex-col justify-center rounded-xl border bg-card px-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:border-primary aria-[current=true]:shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary),transparent_72%)]"
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    height: node.height,
                  }}
                  data-testid="connection-node"
                  data-card-id={card.id}
                  data-node-x={node.x}
                  data-node-y={node.y}
                  data-node-width={node.width}
                  data-node-height={node.height}
                >
                  <span className="font-mono text-[11px] font-semibold text-accent-foreground">
                    {formatDisplayId(card.displayId)}
                  </span>
                  <span className="mt-1 block w-full truncate font-heading font-semibold">
                    {visibleTitle(card.title)}
                  </span>
                  {isCurrent && <span className="sr-only">現在のカード</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {layout && graph.edges.length === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、カード間の一方向リンクが現れます。
        </div>
      )}
    </section>
  );
}
