import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';
import type {
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { invariant } from '@/lib/shared/invariant';
import { fixtureCardId } from '@/tests/fixtures/ids';

export type ConnectionsLayoutFixture = {
  name: string;
  nodes: string[];
  edges: [string, string][];
};

export const connectionsCompatibilityFixtures: ConnectionsLayoutFixture[] = [
  {
    name: 'reported C→A / C→B / A→B',
    nodes: ['A', 'B', 'C'],
    edges: [
      ['C', 'A'],
      ['C', 'B'],
      ['A', 'B'],
    ],
  },
  {
    name: 'diamond',
    nodes: ['A', 'B', 'C', 'D'],
    edges: [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'D'],
      ['C', 'D'],
    ],
  },
  {
    name: 'fan-out',
    nodes: ['A', 'B', 'C', 'D', 'E'],
    edges: ['B', 'C', 'D', 'E'].map((target) => ['A', target]),
  },
  {
    name: 'fan-in',
    nodes: ['A', 'B', 'C', 'D', 'Z'],
    edges: ['A', 'B', 'C', 'D'].map((source) => [source, 'Z']),
  },
  {
    name: 'cycle',
    nodes: ['A', 'B', 'C'],
    edges: [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ],
  },
  { name: 'self link', nodes: ['A'], edges: [['A', 'A']] },
  {
    name: 'mutual links',
    nodes: ['A', 'B'],
    edges: [
      ['A', 'B'],
      ['B', 'A'],
    ],
  },
  {
    name: 'disconnected components',
    nodes: ['A', 'B', 'C', 'D', 'E'],
    edges: [
      ['A', 'B'],
      ['C', 'D'],
    ],
  },
  {
    name: 'dense K3,3',
    nodes: ['A', 'B', 'C', 'X', 'Y', 'Z'],
    edges: ['A', 'B', 'C'].flatMap((source) =>
      ['X', 'Y', 'Z'].map((target): [string, string] => [source, target]),
    ),
  },
];

function seededSyntheticFixture(
  name: string,
  nodeCount: number,
  edgeCount: number,
  seed: number,
): ConnectionsLayoutFixture {
  const nodes = Array.from(
    { length: nodeCount },
    (_, index) => `N${String(index + 1).padStart(3, '0')}`,
  );
  const edges = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const source = nodes[index];
    const target = nodes[(index + 1) % nodes.length];
    invariant(source, `Missing synthetic source ${index}`);
    invariant(target, `Missing synthetic target ${index}`);
    edges.add(`${source}\u0000${target}`);
  }
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  while (edges.size < edgeCount) {
    const sourceIndex = next() % nodeCount;
    let targetIndex = next() % nodeCount;
    if (targetIndex === sourceIndex)
      targetIndex = (targetIndex + 1) % nodeCount;
    const source = nodes[sourceIndex];
    const target = nodes[targetIndex];
    invariant(source, `Missing generated source ${sourceIndex}`);
    invariant(target, `Missing generated target ${targetIndex}`);
    edges.add(`${source}\u0000${target}`);
  }
  return {
    name,
    nodes,
    edges: [...edges]
      .map((edge): [string, string] => {
        const [source, target] = edge.split('\u0000');
        invariant(source, 'Synthetic edge omitted source');
        invariant(target, 'Synthetic edge omitted target');
        return [source, target];
      })
      .sort(
        ([leftSource, leftTarget], [rightSource, rightTarget]) =>
          leftSource.localeCompare(rightSource) ||
          leftTarget.localeCompare(rightTarget),
      ),
  };
}

export const connectionsBenchmarkFixtures: ConnectionsLayoutFixture[] = [
  ...connectionsCompatibilityFixtures,
  seededSyntheticFixture(
    'synthetic medium seed 0x41c0ffee',
    24,
    48,
    0x41c0ffee,
  ),
  seededSyntheticFixture(
    'synthetic large seed 0x41decade',
    48,
    120,
    0x41decade,
  ),
];

export function connectionsFixtureGraph(
  fixture: ConnectionsLayoutFixture,
): ConnectionsLayoutGraph {
  const outgoing = new Map(fixture.nodes.map((id) => [id, [] as string[]]));
  for (const [source, target] of fixture.edges) {
    const targets = outgoing.get(source);
    invariant(targets, `Fixture is missing source ${source}`);
    targets.push(target);
  }
  const cards: CardRecord[] = fixture.nodes.map((id, index) => ({
    id: fixtureCardId(`${fixture.name}-${id}`),
    displayId: { kind: 'official', value: index + 1 },
    title: id,
    body: (outgoing.get(id) ?? []).map((target) => ({
      type: 'link',
      targetCardId: fixtureCardId(`${fixture.name}-${target}`),
    })),
    createdAt: index,
    updatedAt: index,
    localRevision: 1,
    serverRevision: 1,
  }));
  const graph = buildConnectionsGraph(cards);
  return {
    nodes: graph.nodes.map(({ card }) => ({ id: card.id })),
    edges: graph.edges,
  };
}

export const compactConnectionsMetrics: ConnectionsLayoutMetrics = {
  nodeWidth: 148,
  nodeHeight: 56,
  portSize: 2,
  componentSpacing: 64,
  nodeSpacing: 48,
  edgeNodeSpacing: 24,
  layerSpacing: 80,
  edgeLayerSpacing: 28,
  padding: { top: 16, right: 16, bottom: 16, left: 16 },
};

export const spaciousConnectionsMetrics: ConnectionsLayoutMetrics = {
  nodeWidth: 232,
  nodeHeight: 96,
  portSize: 4,
  componentSpacing: 128,
  nodeSpacing: 96,
  edgeNodeSpacing: 44,
  layerSpacing: 148,
  edgeLayerSpacing: 56,
  padding: { top: 32, right: 40, bottom: 36, left: 44 },
};
