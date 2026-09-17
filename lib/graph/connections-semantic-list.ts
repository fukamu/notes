import type {
  ConnectionsInputModel,
  ConnectionsSemanticEdge,
  ConnectionsSemanticNode,
} from '@/lib/graph/connections-contract';
import type { CardId } from '@/lib/domain/id';
import { invariant } from '@/lib/shared/invariant';

export const CONNECTIONS_SEMANTIC_PAGE_SIZE = 50;

export type ConnectionsSemanticCardRecord = Readonly<{
  node: ConnectionsSemanticNode;
  searchText: string;
}>;

export type ConnectionsSemanticEdgeRecord = Readonly<{
  edge: ConnectionsSemanticEdge;
  source: ConnectionsSemanticNode;
  target: ConnectionsSemanticNode;
  searchText: string;
}>;

export type ConnectionsSemanticIndex = Readonly<{
  cards: readonly ConnectionsSemanticCardRecord[];
  edges: readonly ConnectionsSemanticEdgeRecord[];
}>;

export type ConnectionsSemanticPage<T> = Readonly<{
  items: readonly T[];
  totalCount: number;
  filteredCount: number;
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
}>;

export type ConnectionsDeletedCardFocusTarget =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'item'; pageIndex: number }>
  | Readonly<{ kind: 'search' }>;

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

export function prepareConnectionsSemanticIndex(
  input: ConnectionsInputModel,
): ConnectionsSemanticIndex {
  const nodesById = new Map(input.nodes.map((node) => [node.cardId, node]));
  const cards = input.nodes.map((node) => ({
    node,
    searchText: normalizeSearchText(`${node.displayLabel} ${node.title}`),
  }));
  const edges = input.edges.map((edge) => {
    const source = nodesById.get(edge.sourceCardId);
    const target = nodesById.get(edge.targetCardId);
    invariant(source, `Missing semantic source node ${edge.sourceCardId}`);
    invariant(target, `Missing semantic target node ${edge.targetCardId}`);
    return {
      edge,
      source,
      target,
      searchText: normalizeSearchText(
        `${source.displayLabel} ${source.title} ${target.displayLabel} ${target.title}`,
      ),
    };
  });
  return { cards, edges };
}

export function selectConnectionsSemanticPage<
  T extends Readonly<{ searchText: string }>,
>(
  records: readonly T[],
  query: string,
  requestedPage: number,
  pageSize = CONNECTIONS_SEMANTIC_PAGE_SIZE,
): ConnectionsSemanticPage<T> {
  const safePageSize =
    Number.isSafeInteger(pageSize) && pageSize > 0
      ? pageSize
      : CONNECTIONS_SEMANTIC_PAGE_SIZE;
  const queryTerms = normalizeSearchText(query.trim())
    .split(/\s+/)
    .filter(Boolean);
  const filtered = queryTerms.length
    ? records.filter((record) =>
        queryTerms.every((term) => record.searchText.includes(term)),
      )
    : records;
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const safeRequestedPage = Number.isSafeInteger(requestedPage)
    ? requestedPage
    : 1;
  const page = Math.min(pageCount, Math.max(1, safeRequestedPage));
  const startIndex = (page - 1) * safePageSize;
  const items = filtered.slice(startIndex, startIndex + safePageSize);
  return {
    items,
    totalCount: records.length,
    filteredCount: filtered.length,
    page,
    pageCount,
    rangeStart: items.length === 0 ? 0 : startIndex + 1,
    rangeEnd: startIndex + items.length,
  };
}

export function resolveConnectionsDeletedCardFocusTarget(
  focusedCardId: CardId,
  previousPageIndex: number,
  allCards: readonly ConnectionsSemanticCardRecord[],
  pageItems: readonly ConnectionsSemanticCardRecord[],
): ConnectionsDeletedCardFocusTarget {
  if (allCards.some(({ node }) => node.cardId === focusedCardId)) {
    return { kind: 'unchanged' };
  }
  if (pageItems.length === 0) return { kind: 'search' };
  const safeIndex = Number.isSafeInteger(previousPageIndex)
    ? previousPageIndex
    : 0;
  return {
    kind: 'item',
    pageIndex: Math.min(pageItems.length - 1, Math.max(0, safeIndex)),
  };
}
