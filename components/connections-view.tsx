'use client';

import { ArrowRight, Network } from 'lucide-react';
import { buildReachableGraph } from '@/lib/domain/graph';
import { formatDisplayId } from '@/lib/domain/display-id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';

type Props = {
  cards: CardRecord[];
  currentCardId: string;
  onSelect: (cardId: string) => void;
};

const NODE_WIDTH = 196;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 88;
const ROW_GAP = 28;

export function ConnectionsView({ cards, currentCardId, onSelect }: Props) {
  const graph = buildReachableGraph(cards, currentCardId);
  const grouped = new Map<number, typeof graph.nodes>();
  for (const node of graph.nodes) {
    grouped.set(node.depth, [...(grouped.get(node.depth) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, nodes] of grouped) {
    nodes.forEach((node, row) => {
      positions.set(node.card.id, {
        x: depth * (NODE_WIDTH + COLUMN_GAP),
        y: row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }
  const maxDepth = Math.max(0, ...graph.nodes.map((node) => node.depth));
  const maxRows = Math.max(1, ...[...grouped.values()].map((nodes) => nodes.length));
  const width = (maxDepth + 1) * NODE_WIDTH + maxDepth * COLUMN_GAP + 32;
  const height = maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP + 48;

  function edgePath(sourceId: string, targetId: string): string {
    const source = positions.get(sourceId)!;
    const target = positions.get(targetId)!;
    if (sourceId === targetId) {
      const x = source.x + NODE_WIDTH - 24;
      const y = source.y;
      return `M ${x} ${y + 8} C ${x + 50} ${y - 30}, ${x + 54} ${y + 74}, ${x} ${y + 58}`;
    }
    const startX = source.x + NODE_WIDTH;
    const startY = source.y + NODE_HEIGHT / 2;
    const endX = target.x;
    const endY = target.y + NODE_HEIGHT / 2;
    const bend = Math.max(44, Math.abs(endX - startX) / 2);
    const direction = endX >= startX ? 1 : -1;
    return `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`;
  }

  return (
    <section className="mx-auto w-full max-w-5xl" aria-labelledby="connections-heading">
      <div className="mb-5">
        <p className="eyebrow">OUTGOING PATHS</p>
        <h1 id="connections-heading" className="font-heading text-2xl font-semibold">
          つながり
        </h1>
        <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          現在のカードから、明示したリンクの方向だけを辿ります。
          <ArrowRight aria-hidden="true" className="size-4" />
        </p>
      </div>

      <div className="overflow-auto rounded-2xl border bg-card/55 p-4 shadow-sm" data-testid="connections-graph">
        <div className="relative" style={{ width, height, minWidth: '100%' }}>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={width}
            height={height}
          >
            <defs>
              <marker id="edge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {graph.edges.map((edge) => (
              <path
                key={`${edge.sourceCardId}-${edge.targetCardId}`}
                d={edgePath(edge.sourceCardId, edge.targetCardId)}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                markerEnd="url(#edge-arrow)"
                className="text-primary/55"
                data-source={edge.sourceCardId}
                data-target={edge.targetCardId}
              />
            ))}
          </svg>

          {graph.nodes.map(({ card, depth }) => {
            const position = positions.get(card.id)!;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onSelect(card.id)}
                className="absolute flex flex-col justify-center rounded-xl border bg-card px-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  left: position.x,
                  top: position.y + 24,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
                data-card-id={card.id}
                data-depth={depth}
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

      {graph.edges.length === 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          本文でカードをリンクすると、ここから先の道筋が現れます。
        </div>
      )}
    </section>
  );
}
