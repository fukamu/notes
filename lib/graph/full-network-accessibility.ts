import type { CardId } from '@/lib/domain/id';
import type {
  ConnectionsInputModel,
  ConnectionsSemanticEdge,
  ConnectionsSemanticNode,
} from '@/lib/graph/connections-contract';
import type {
  FullNetworkRenderDataset,
  FullNetworkRenderPlan,
  FullNetworkSemanticLevel,
} from '@/lib/graph/full-network-render-plan';

export type FullNetworkAccessibilityIndex = Readonly<{
  datasetKey: string;
  nodes: readonly ConnectionsSemanticNode[];
  edges: readonly ConnectionsSemanticEdge[];
  currentNodeIndex: number | null;
}>;

export type FullNetworkAccessibilityCursor = Readonly<{
  nodeIndex: number | null;
  edgeIndex: number | null;
}>;

export type FullNetworkAccessibilityDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down';

export type FullNetworkAccessibilityEvent =
  | Readonly<{ type: 'move'; direction: FullNetworkAccessibilityDirection }>
  | Readonly<{ type: 'next-node'; direction: 1 | -1 }>
  | Readonly<{ type: 'next-edge'; direction: 1 | -1 }>
  | Readonly<{ type: 'next-neighbor'; direction: 1 | -1 }>
  | Readonly<{ type: 'next-component'; direction: 1 | -1 }>
  | Readonly<{ type: 'select-card'; cardId: CardId }>
  | Readonly<{ type: 'select-current' }>
  | Readonly<{ type: 'clear-edge' }>;

export type FullNetworkAccessibilityOverlayItem = Readonly<{
  nodeIndex: number;
  cardId: CardId;
  accessibleName: string;
  displayLabel: string;
  title: string;
  screenX: number;
  screenY: number;
  current: boolean;
  selected: boolean;
}>;

export type FullNetworkAccessibilityAnnouncement = Readonly<{
  summary: string;
  selection: string;
}>;

export type FullNetworkAvailabilityInput = Readonly<{
  layout:
    | Readonly<{
        status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'destroyed';
        hasCompleteLayout: boolean;
      }>
    | Readonly<{
        status: 'error';
        hasCompleteLayout: boolean;
        reason: 'worker-failure' | 'worker-rejected' | 'invalid-response';
      }>;
  renderer:
    | Readonly<{
        status: 'idle' | 'building' | 'ready' | 'disposed';
      }>
    | Readonly<{ status: 'context-lost' }>
    | Readonly<{ status: 'error'; message: string }>;
}>;

export type FullNetworkAvailability =
  | Readonly<{ kind: 'loading'; message: string }>
  | Readonly<{ kind: 'ready' }>
  | Readonly<{
      kind: 'stale';
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: 'error';
      message: string;
      retryable: true;
    }>
  | Readonly<{ kind: 'unavailable'; message: string }>;

const minimumTouchTargetPixels = 44;

function typedValue(
  values: Uint32Array | Float32Array,
  index: number,
  label: string,
): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}

function nodeAt(
  index: FullNetworkAccessibilityIndex,
  nodeIndex: number,
): ConnectionsSemanticNode {
  const node = index.nodes[nodeIndex];
  if (!node) throw new Error(`Missing accessible node at ${nodeIndex}`);
  return node;
}

function edgeAt(
  index: FullNetworkAccessibilityIndex,
  edgeIndex: number,
): ConnectionsSemanticEdge {
  const edge = index.edges[edgeIndex];
  if (!edge) throw new Error(`Missing accessible edge at ${edgeIndex}`);
  return edge;
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function currentOrFirstNode(
  index: FullNetworkAccessibilityIndex,
  cursor: FullNetworkAccessibilityCursor,
): number | null {
  if (cursor.nodeIndex !== null && cursor.nodeIndex < index.nodes.length) {
    return cursor.nodeIndex;
  }
  return index.currentNodeIndex ?? (index.nodes.length > 0 ? 0 : null);
}

export function createFullNetworkAccessibilityIndex(
  input: ConnectionsInputModel,
  dataset: FullNetworkRenderDataset,
): FullNetworkAccessibilityIndex {
  if (input.nodes.length !== dataset.routing.topology.nodeIds.length) {
    throw new Error('Accessible node count does not match full-network data');
  }
  if (input.edges.length !== dataset.routing.topology.sources.length) {
    throw new Error('Accessible edge count does not match full-network data');
  }
  for (const [nodeIndex, node] of input.nodes.entries()) {
    if (dataset.routing.topology.nodeIds[nodeIndex] !== node.cardId) {
      throw new Error(`Accessible node order differs at ${nodeIndex}`);
    }
  }
  for (const [edgeIndex, edge] of input.edges.entries()) {
    const source = typedValue(
      dataset.routing.topology.sources,
      edgeIndex,
      'accessible edge source',
    );
    const target = typedValue(
      dataset.routing.topology.targets,
      edgeIndex,
      'accessible edge target',
    );
    if (
      dataset.routing.topology.nodeIds[source] !== edge.sourceCardId ||
      dataset.routing.topology.nodeIds[target] !== edge.targetCardId
    ) {
      throw new Error(`Accessible edge order differs at ${edgeIndex}`);
    }
  }
  return {
    datasetKey: dataset.datasetKey,
    nodes: input.nodes,
    edges: input.edges,
    currentNodeIndex:
      dataset.nodeIndexesByCardId.get(input.currentCardId) ?? null,
  };
}

export function initialFullNetworkAccessibilityCursor(
  index: FullNetworkAccessibilityIndex,
  selectedCardId: CardId | null = null,
): FullNetworkAccessibilityCursor {
  const selectedIndex = selectedCardId
    ? index.nodes.findIndex((node) => node.cardId === selectedCardId)
    : -1;
  return {
    nodeIndex:
      selectedIndex >= 0
        ? selectedIndex
        : (index.currentNodeIndex ?? (index.nodes.length > 0 ? 0 : null)),
    edgeIndex: null,
  };
}

function spatialNode(
  index: FullNetworkAccessibilityIndex,
  dataset: FullNetworkRenderDataset,
  start: number,
  direction: FullNetworkAccessibilityDirection,
): number {
  const startX = typedValue(dataset.routing.layout.x, start, 'start x');
  const startY = typedValue(dataset.routing.layout.y, start, 'start y');
  let best = start;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < index.nodes.length; candidate += 1) {
    if (candidate === start) continue;
    const deltaX =
      typedValue(dataset.routing.layout.x, candidate, 'candidate x') - startX;
    const deltaY =
      typedValue(dataset.routing.layout.y, candidate, 'candidate y') - startY;
    const primary =
      direction === 'left'
        ? -deltaX
        : direction === 'right'
          ? deltaX
          : direction === 'up'
            ? -deltaY
            : deltaY;
    if (primary <= 0) continue;
    const secondary =
      direction === 'left' || direction === 'right'
        ? Math.abs(deltaY)
        : Math.abs(deltaX);
    const score = primary * primary + secondary * secondary * 4;
    if (score < bestScore || (score === bestScore && candidate < best)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function adjacentSelection(
  index: FullNetworkAccessibilityIndex,
  dataset: FullNetworkRenderDataset,
  cursor: FullNetworkAccessibilityCursor,
  direction: 1 | -1,
): FullNetworkAccessibilityCursor {
  const nodeIndex = currentOrFirstNode(index, cursor);
  if (nodeIndex === null) return { nodeIndex: null, edgeIndex: null };
  const start = typedValue(
    dataset.incidents.offsets,
    nodeIndex,
    'incident start',
  );
  const end = typedValue(
    dataset.incidents.offsets,
    nodeIndex + 1,
    'incident end',
  );
  const length = end - start;
  if (length === 0) return { nodeIndex, edgeIndex: null };
  let currentPosition = direction === 1 ? -1 : 0;
  if (cursor.edgeIndex !== null) {
    for (let position = 0; position < length; position += 1) {
      if (
        typedValue(
          dataset.incidents.edgeIndexes,
          start + position,
          'incident edge',
        ) === cursor.edgeIndex
      ) {
        currentPosition = position;
        break;
      }
    }
  }
  const position = wrap(currentPosition + direction, length);
  const edgeIndex = typedValue(
    dataset.incidents.edgeIndexes,
    start + position,
    'next incident edge',
  );
  const source = typedValue(
    dataset.routing.topology.sources,
    edgeIndex,
    'neighbor source',
  );
  const target = typedValue(
    dataset.routing.topology.targets,
    edgeIndex,
    'neighbor target',
  );
  return {
    nodeIndex: source === nodeIndex ? target : source,
    edgeIndex,
  };
}

function componentSelection(
  index: FullNetworkAccessibilityIndex,
  dataset: FullNetworkRenderDataset,
  cursor: FullNetworkAccessibilityCursor,
  direction: 1 | -1,
): FullNetworkAccessibilityCursor {
  const nodeIndex = currentOrFirstNode(index, cursor);
  if (nodeIndex === null || dataset.routing.layout.components.length === 0) {
    return { nodeIndex, edgeIndex: null };
  }
  const currentComponent = typedValue(
    dataset.routing.layout.componentIndex,
    nodeIndex,
    'current component',
  );
  const nextComponent = wrap(
    currentComponent + direction,
    dataset.routing.layout.components.length,
  );
  const component = dataset.routing.layout.components[nextComponent];
  const nextNode = component?.nodeIndexes[0];
  if (nextNode === undefined) return { nodeIndex, edgeIndex: null };
  return { nodeIndex: nextNode, edgeIndex: null };
}

export function transitionFullNetworkAccessibilityCursor(
  index: FullNetworkAccessibilityIndex,
  dataset: FullNetworkRenderDataset,
  cursor: FullNetworkAccessibilityCursor,
  event: FullNetworkAccessibilityEvent,
): FullNetworkAccessibilityCursor {
  if (index.datasetKey !== dataset.datasetKey) {
    throw new Error('Accessibility index does not match the render dataset');
  }
  switch (event.type) {
    case 'move': {
      const start = currentOrFirstNode(index, cursor);
      return start === null
        ? { nodeIndex: null, edgeIndex: null }
        : {
            nodeIndex: spatialNode(index, dataset, start, event.direction),
            edgeIndex: null,
          };
    }
    case 'next-node': {
      if (index.nodes.length === 0) return { nodeIndex: null, edgeIndex: null };
      const start = currentOrFirstNode(index, cursor) ?? 0;
      return {
        nodeIndex: wrap(start + event.direction, index.nodes.length),
        edgeIndex: null,
      };
    }
    case 'next-edge': {
      if (index.edges.length === 0) return { ...cursor, edgeIndex: null };
      const start = cursor.edgeIndex ?? (event.direction === 1 ? -1 : 0);
      const edgeIndex = wrap(start + event.direction, index.edges.length);
      const source = typedValue(
        dataset.routing.topology.sources,
        edgeIndex,
        'selected edge source',
      );
      return { nodeIndex: source, edgeIndex };
    }
    case 'next-neighbor':
      return adjacentSelection(index, dataset, cursor, event.direction);
    case 'next-component':
      return componentSelection(index, dataset, cursor, event.direction);
    case 'select-card': {
      const nodeIndex = index.nodes.findIndex(
        (node) => node.cardId === event.cardId,
      );
      return nodeIndex < 0 ? cursor : { nodeIndex, edgeIndex: null };
    }
    case 'select-current':
      return {
        nodeIndex: index.currentNodeIndex,
        edgeIndex: null,
      };
    case 'clear-edge':
      return { ...cursor, edgeIndex: null };
  }
}

function levelLabel(level: FullNetworkSemanticLevel): string {
  switch (level) {
    case 'overview':
      return '全体俯瞰';
    case 'network':
      return 'ネットワーク';
    case 'detail':
      return '詳細';
  }
}

export function describeFullNetworkAccessibility(
  index: FullNetworkAccessibilityIndex,
  cursor: FullNetworkAccessibilityCursor,
  level: FullNetworkSemanticLevel,
): FullNetworkAccessibilityAnnouncement {
  const current =
    index.currentNodeIndex === null
      ? 'なし'
      : nodeAt(index, index.currentNodeIndex).accessibleName;
  const summary = `つながりマップ。全${index.nodes.length.toLocaleString('ja-JP')}枚、全${index.edges.length.toLocaleString('ja-JP')}本。表示段階は${levelLabel(level)}。現在のカードは${current}。`;
  if (cursor.edgeIndex !== null && cursor.edgeIndex < index.edges.length) {
    const edge = edgeAt(index, cursor.edgeIndex);
    return {
      summary,
      selection: `リンク ${cursor.edgeIndex + 1}/${index.edges.length}、${edge.accessibleName}`,
    };
  }
  if (cursor.nodeIndex !== null && cursor.nodeIndex < index.nodes.length) {
    const node = nodeAt(index, cursor.nodeIndex);
    return {
      summary,
      selection: `カード ${cursor.nodeIndex + 1}/${index.nodes.length}、${node.accessibleName}`,
    };
  }
  return { summary, selection: '選択中のカードはありません' };
}

function overlayPriority(
  nodeIndex: number,
  plan: FullNetworkRenderPlan,
): number {
  if (nodeIndex === plan.selectedNodeIndex) return 0;
  if (nodeIndex === plan.currentNodeIndex) return 1;
  return 2;
}

export function createFullNetworkAccessibilityOverlay(
  index: FullNetworkAccessibilityIndex,
  dataset: FullNetworkRenderDataset,
  plan: FullNetworkRenderPlan,
): readonly FullNetworkAccessibilityOverlayItem[] {
  if (
    index.datasetKey !== dataset.datasetKey ||
    plan.datasetKey !== dataset.datasetKey
  ) {
    throw new Error('Accessibility overlay does not match the render dataset');
  }
  if (plan.level !== 'detail') return [];
  const candidates = Array.from(plan.visibleNodeIndexes);
  candidates.sort(
    (left, right) =>
      overlayPriority(left, plan) - overlayPriority(right, plan) ||
      left - right,
  );
  const cells = new Set<string>();
  const items: FullNetworkAccessibilityOverlayItem[] = [];
  for (const nodeIndex of candidates) {
    const screenX =
      plan.camera.offsetX +
      typedValue(dataset.routing.layout.x, nodeIndex, 'overlay x') *
        plan.camera.scale;
    const screenY =
      plan.camera.offsetY +
      typedValue(dataset.routing.layout.y, nodeIndex, 'overlay y') *
        plan.camera.scale;
    if (
      screenX < 0 ||
      screenY < 0 ||
      screenX > plan.camera.viewportWidth ||
      screenY > plan.camera.viewportHeight
    ) {
      continue;
    }
    const cell = `${Math.floor(screenX / minimumTouchTargetPixels)}:${Math.floor(screenY / minimumTouchTargetPixels)}`;
    if (cells.has(cell)) continue;
    cells.add(cell);
    const node = nodeAt(index, nodeIndex);
    items.push({
      nodeIndex,
      cardId: node.cardId,
      accessibleName: node.accessibleName,
      displayLabel: node.displayLabel,
      title: node.title,
      screenX,
      screenY,
      current: nodeIndex === plan.currentNodeIndex,
      selected: nodeIndex === plan.selectedNodeIndex,
    });
  }
  return items;
}

export function fullNetworkAccessibilityOverlayLimit(
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    throw new RangeError('Accessibility viewport must be finite and positive');
  }
  return (
    (Math.floor(viewportWidth / minimumTouchTargetPixels) + 1) *
    (Math.floor(viewportHeight / minimumTouchTargetPixels) + 1)
  );
}

export function deriveFullNetworkAvailability(
  input: FullNetworkAvailabilityInput,
): FullNetworkAvailability {
  if (
    input.layout.status === 'destroyed' ||
    input.renderer.status === 'disposed'
  ) {
    return {
      kind: 'unavailable',
      message: 'つながりマップは終了しました',
    };
  }
  if (input.layout.status === 'error') {
    const message =
      input.layout.reason === 'invalid-response'
        ? '受信した配置データを確認できませんでした'
        : 'つながりの配置を計算できませんでした';
    return input.layout.hasCompleteLayout && input.renderer.status === 'ready'
      ? { kind: 'stale', message, retryable: true }
      : { kind: 'error', message, retryable: true };
  }
  if (input.renderer.status === 'context-lost') {
    return {
      kind: 'error',
      message: '描画を継続できませんでした',
      retryable: true,
    };
  }
  if (input.renderer.status === 'error') {
    return {
      kind: 'error',
      message: 'つながりマップを描画できませんでした',
      retryable: true,
    };
  }
  if (
    input.layout.status === 'refreshing' &&
    input.layout.hasCompleteLayout &&
    input.renderer.status === 'ready'
  ) {
    return {
      kind: 'stale',
      message: '更新した配置を計算しています',
      retryable: false,
    };
  }
  if (input.layout.status !== 'ready' || input.renderer.status !== 'ready') {
    return { kind: 'loading', message: 'つながりを準備しています' };
  }
  return { kind: 'ready' };
}
