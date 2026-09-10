import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type {
  ELK,
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort,
} from 'elkjs/lib/elk-api.js';
import type { ConnectionsGraph, DirectedEdge } from '@/lib/domain/graph';
import { invariant } from '@/lib/shared/invariant';

export const CONNECTION_NODE_WIDTH = 196;
export const CONNECTION_NODE_HEIGHT = 72;
const PORT_SIZE = 2;

export const CONNECTIONS_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.randomSeed': '1',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '96',
  'elk.spacing.nodeNode': '72',
  'elk.spacing.edgeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '112',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.thoroughness': '7',
  'elk.layered.mergeEdges': 'false',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
} as const;

export type LayoutPoint = ElkPoint;

export type ConnectionsLayoutPort = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  side: 'EAST' | 'WEST';
};

export type ConnectionsLayoutNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ports: ConnectionsLayoutPort[];
};

export type ConnectionsLayoutSection = {
  id: string;
  startPoint: LayoutPoint;
  bendPoints: LayoutPoint[];
  endPoint: LayoutPoint;
  incomingShape?: string;
  outgoingShape?: string;
};

export type ConnectionsLayoutEdge = DirectedEdge & {
  id: string;
  sourcePortId: string;
  targetPortId: string;
  sections: ConnectionsLayoutSection[];
};

export type ConnectionsLayout = {
  width: number;
  height: number;
  nodes: ConnectionsLayoutNode[];
  edges: ConnectionsLayoutEdge[];
};

type EdgeInput = DirectedEdge & {
  id: string;
  sourcePortId: string;
  targetPortId: string;
};

let elkInstance: ELK | undefined;

function elkEngine(): ELK {
  elkInstance ??= new ElkConstructor({ algorithms: ['layered'] });
  return elkInstance;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requiredNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value))
    throw new Error(`ELK returned an invalid ${label}`);
  return value;
}

function requiredPoint(
  point: ElkPoint | undefined,
  label: string,
): LayoutPoint {
  if (!point) throw new Error(`ELK omitted ${label}`);
  return {
    x: requiredNumber(point.x, `${label}.x`),
    y: requiredNumber(point.y, `${label}.y`),
  };
}

function edgeInputs(graph: ConnectionsGraph): EdgeInput[] {
  return graph.edges.map((edge, index) => ({
    ...edge,
    id: `edge-${index}`,
    sourcePortId: `port-${index}-source`,
    targetPortId: `port-${index}-target`,
  }));
}

function elkPort(id: string, side: 'EAST' | 'WEST'): ElkPort {
  return {
    id,
    width: PORT_SIZE,
    height: PORT_SIZE,
    layoutOptions: { 'elk.port.side': side },
  };
}

function elkGraph(graph: ConnectionsGraph, inputs: EdgeInput[]): ElkNode {
  const portsByNode = new Map<string, ElkPort[]>(
    graph.nodes.map((node) => [node.card.id, []]),
  );
  for (const edge of inputs) {
    const sourcePorts = portsByNode.get(edge.sourceCardId);
    const targetPorts = portsByNode.get(edge.targetCardId);
    invariant(sourcePorts, `Missing source node ${edge.sourceCardId}`);
    invariant(targetPorts, `Missing target node ${edge.targetCardId}`);
    sourcePorts.push(elkPort(edge.sourcePortId, 'EAST'));
    targetPorts.push(elkPort(edge.targetPortId, 'WEST'));
  }

  return {
    id: 'connections-root',
    layoutOptions: CONNECTIONS_LAYOUT_OPTIONS,
    children: graph.nodes.map((node) => {
      const ports = portsByNode.get(node.card.id);
      invariant(ports, `Missing ports for node ${node.card.id}`);
      return {
        id: node.card.id,
        width: CONNECTION_NODE_WIDTH,
        height: CONNECTION_NODE_HEIGHT,
        ports,
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      };
    }),
    edges: inputs.map(
      (edge): ElkExtendedEdge => ({
        id: edge.id,
        sources: [edge.sourcePortId],
        targets: [edge.targetPortId],
      }),
    ),
  };
}

function layoutSection(section: ElkEdgeSection): ConnectionsLayoutSection {
  return {
    id: section.id,
    startPoint: requiredPoint(section.startPoint, `${section.id}.startPoint`),
    bendPoints: (section.bendPoints ?? []).map((point, index) =>
      requiredPoint(point, `${section.id}.bendPoints[${index}]`),
    ),
    endPoint: requiredPoint(section.endPoint, `${section.id}.endPoint`),
    ...(section.incomingShape === undefined
      ? {}
      : { incomingShape: section.incomingShape }),
    ...(section.outgoingShape === undefined
      ? {}
      : { outgoingShape: section.outgoingShape }),
  };
}

export function sectionPath(section: ConnectionsLayoutSection): string {
  const points = [section.startPoint, ...section.bendPoints, section.endPoint];
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

export async function layoutConnectionsGraph(
  graph: ConnectionsGraph,
): Promise<ConnectionsLayout> {
  const inputs = edgeInputs(graph);
  const elk = elkEngine();
  const result = await elk.layout(elkGraph(graph, inputs));
  const laidOutNodes = new Map(
    (result.children ?? []).map((node) => [node.id, node]),
  );
  const laidOutEdges = new Map(
    (result.edges ?? []).map((edge) => [edge.id, edge]),
  );

  const nodes = graph.nodes.map(({ card }) => {
    const node = laidOutNodes.get(card.id);
    if (!node) throw new Error(`ELK omitted node ${card.id}`);
    const x = requiredNumber(node.x, `${card.id}.x`);
    const y = requiredNumber(node.y, `${card.id}.y`);
    const width = requiredNumber(node.width, `${card.id}.width`);
    const height = requiredNumber(node.height, `${card.id}.height`);
    const ports = (node.ports ?? []).map((port): ConnectionsLayoutPort => {
      const side = port.layoutOptions?.['elk.port.side'];
      if (side !== 'EAST' && side !== 'WEST') {
        throw new Error(`ELK returned an invalid side for port ${port.id}`);
      }
      return {
        id: port.id,
        x: x + requiredNumber(port.x, `${port.id}.x`),
        y: y + requiredNumber(port.y, `${port.id}.y`),
        width: requiredNumber(port.width, `${port.id}.width`),
        height: requiredNumber(port.height, `${port.id}.height`),
        side,
      };
    });
    return { id: card.id, x, y, width, height, ports };
  });

  const edges = inputs.map((input): ConnectionsLayoutEdge => {
    const edge = laidOutEdges.get(input.id);
    if (!edge) throw new Error(`ELK omitted edge ${input.id}`);
    if (!edge.sections?.length)
      throw new Error(`ELK omitted sections for edge ${input.id}`);
    return {
      ...input,
      sections: edge.sections.map(layoutSection),
    };
  });

  return {
    width: requiredNumber(result.width, 'graph width'),
    height: requiredNumber(result.height, 'graph height'),
    nodes,
    edges,
  };
}
