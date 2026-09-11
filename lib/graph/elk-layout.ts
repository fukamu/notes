import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import type {
  ELK,
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort,
} from 'elkjs/lib/elk-api.js';
import type { DirectedEdge } from '@/lib/domain/graph';
import type { CardId } from '@/lib/domain/id';
import { invariant } from '@/lib/shared/invariant';

export const CONNECTIONS_LAYOUT_ALGORITHM_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.randomSeed': '1',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.thoroughness': '7',
  'elk.layered.mergeEdges': 'false',
} as const;

export type ConnectionsEdgeRouting = 'ORTHOGONAL' | 'SPLINES';
export type ConnectionsPortPolicy = 'FIXED_SIDE' | 'FIXED_ORDER';
export type ConnectionsSplineRoutingMode =
  | 'CONSERVATIVE'
  | 'CONSERVATIVE_SOFT'
  | 'SLOPPY';

export type ConnectionsLayoutConfiguration = Readonly<{
  edgeRouting: ConnectionsEdgeRouting;
  portPolicy: ConnectionsPortPolicy;
  splineRoutingMode?: ConnectionsSplineRoutingMode;
  addUnnecessaryBendpoints?: boolean;
  favorStraightEdges?: boolean;
  straightnessPriority?: number;
  shortnessPriority?: number;
}>;

export const DEFAULT_CONNECTIONS_LAYOUT_CONFIGURATION = {
  edgeRouting: 'ORTHOGONAL',
  portPolicy: 'FIXED_SIDE',
} as const satisfies ConnectionsLayoutConfiguration;

export type ConnectionsLayoutMetrics = {
  nodeWidth: number;
  nodeHeight: number;
  portSize: number;
  componentSpacing: number;
  nodeSpacing: number;
  edgeNodeSpacing: number;
  layerSpacing: number;
  edgeLayerSpacing: number;
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

export type ConnectionsLayoutGraph = {
  nodes: { id: CardId }[];
  edges: DirectedEdge[];
};

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
  id: CardId;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalPriority(value: number | undefined, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Connections layout priority ${label} must be a non-negative integer`,
    );
  }
  return String(value);
}

function requiredNumber(value: unknown, label: string): number {
  if (!isFiniteNumber(value))
    throw new Error(`ELK returned an invalid ${label}`);
  return value;
}

function requiredMetric(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Connections layout metric ${label} must be positive`);
  }
  return value;
}

export function connectionsLayoutOptions(
  metrics: ConnectionsLayoutMetrics,
  configuration: ConnectionsLayoutConfiguration = DEFAULT_CONNECTIONS_LAYOUT_CONFIGURATION,
): Record<string, string> {
  const padding = metrics.padding;
  const options: Record<string, string> = {
    ...CONNECTIONS_LAYOUT_ALGORITHM_OPTIONS,
    'elk.edgeRouting': configuration.edgeRouting,
    'elk.spacing.componentComponent': String(
      requiredMetric(metrics.componentSpacing, 'componentSpacing'),
    ),
    'elk.spacing.nodeNode': String(
      requiredMetric(metrics.nodeSpacing, 'nodeSpacing'),
    ),
    'elk.spacing.edgeNode': String(
      requiredMetric(metrics.edgeNodeSpacing, 'edgeNodeSpacing'),
    ),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(
      requiredMetric(metrics.layerSpacing, 'layerSpacing'),
    ),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(
      requiredMetric(metrics.edgeLayerSpacing, 'edgeLayerSpacing'),
    ),
    'elk.padding': `[top=${requiredMetric(padding.top, 'padding.top')},left=${requiredMetric(padding.left, 'padding.left')},bottom=${requiredMetric(padding.bottom, 'padding.bottom')},right=${requiredMetric(padding.right, 'padding.right')}]`,
  };
  if (configuration.splineRoutingMode !== undefined) {
    options['elk.layered.edgeRouting.splines.mode'] =
      configuration.splineRoutingMode;
  }
  if (configuration.addUnnecessaryBendpoints !== undefined) {
    options['elk.layered.unnecessaryBendpoints'] = String(
      configuration.addUnnecessaryBendpoints,
    );
  }
  if (configuration.favorStraightEdges !== undefined) {
    options['elk.layered.nodePlacement.favorStraightEdges'] = String(
      configuration.favorStraightEdges,
    );
  }
  return options;
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

function edgeInputs(graph: ConnectionsLayoutGraph): EdgeInput[] {
  return graph.edges.map((edge, index) => ({
    ...edge,
    id: `edge-${index}`,
    sourcePortId: `port-${index}-source`,
    targetPortId: `port-${index}-target`,
  }));
}

function elkPort(
  id: string,
  side: 'EAST' | 'WEST',
  metrics: ConnectionsLayoutMetrics,
): ElkPort {
  return {
    id,
    width: requiredMetric(metrics.portSize, 'portSize'),
    height: requiredMetric(metrics.portSize, 'portSize'),
    layoutOptions: { 'elk.port.side': side },
  };
}

function elkGraph(
  graph: ConnectionsLayoutGraph,
  inputs: EdgeInput[],
  metrics: ConnectionsLayoutMetrics,
  configuration: ConnectionsLayoutConfiguration,
): ElkNode {
  const portsByNode = new Map<string, ElkPort[]>(
    graph.nodes.map((node) => [node.id, []]),
  );
  for (const edge of inputs) {
    const sourcePorts = portsByNode.get(edge.sourceCardId);
    const targetPorts = portsByNode.get(edge.targetCardId);
    invariant(sourcePorts, `Missing source node ${edge.sourceCardId}`);
    invariant(targetPorts, `Missing target node ${edge.targetCardId}`);
    sourcePorts.push(elkPort(edge.sourcePortId, 'EAST', metrics));
    targetPorts.push(elkPort(edge.targetPortId, 'WEST', metrics));
  }

  return {
    id: 'connections-root',
    layoutOptions: connectionsLayoutOptions(metrics, configuration),
    children: graph.nodes.map((node) => {
      const ports = portsByNode.get(node.id);
      invariant(ports, `Missing ports for node ${node.id}`);
      return {
        id: node.id,
        width: requiredMetric(metrics.nodeWidth, 'nodeWidth'),
        height: requiredMetric(metrics.nodeHeight, 'nodeHeight'),
        ports: ports.map((port, index) => ({
          ...port,
          layoutOptions: {
            ...port.layoutOptions,
            ...(configuration.portPolicy === 'FIXED_ORDER'
              ? { 'elk.port.index': String(index) }
              : {}),
          },
        })),
        layoutOptions: { 'elk.portConstraints': configuration.portPolicy },
      };
    }),
    edges: inputs.map((edge): ElkExtendedEdge => {
      const straightness = optionalPriority(
        configuration.straightnessPriority,
        'straightness',
      );
      const shortness = optionalPriority(
        configuration.shortnessPriority,
        'shortness',
      );
      return {
        id: edge.id,
        sources: [edge.sourcePortId],
        targets: [edge.targetPortId],
        ...(!straightness && !shortness
          ? {}
          : {
              layoutOptions: {
                ...(straightness
                  ? { 'elk.layered.priority.straightness': straightness }
                  : {}),
                ...(shortness
                  ? { 'elk.layered.priority.shortness': shortness }
                  : {}),
              },
            }),
      };
    }),
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

async function layoutConnectionsGraphWithEngine(
  elk: ELK,
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
  configuration: ConnectionsLayoutConfiguration,
): Promise<ConnectionsLayout> {
  const inputs = edgeInputs(graph);
  const result = await elk.layout(
    elkGraph(graph, inputs, metrics, configuration),
  );
  const laidOutNodes = new Map(
    (result.children ?? []).map((node) => [node.id, node]),
  );
  const laidOutEdges = new Map(
    (result.edges ?? []).map((edge) => [edge.id, edge]),
  );

  const nodes = graph.nodes.map(({ id }) => {
    const node = laidOutNodes.get(id);
    if (!node) throw new Error(`ELK omitted node ${id}`);
    const x = requiredNumber(node.x, `${id}.x`);
    const y = requiredNumber(node.y, `${id}.y`);
    const width = requiredNumber(node.width, `${id}.width`);
    const height = requiredNumber(node.height, `${id}.height`);
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
    return { id, x, y, width, height, ports };
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

export type ConnectionsLayoutFunction = (
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
) => Promise<ConnectionsLayout>;

export function createConnectionsLayoutRunner(
  configuration: ConnectionsLayoutConfiguration = DEFAULT_CONNECTIONS_LAYOUT_CONFIGURATION,
): ConnectionsLayoutFunction {
  const elk = new ElkConstructor({ algorithms: ['layered'] });
  return (graph, metrics) =>
    layoutConnectionsGraphWithEngine(elk, graph, metrics, configuration);
}

let defaultLayoutRunner: ConnectionsLayoutFunction | undefined;

export function layoutConnectionsGraph(
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
): Promise<ConnectionsLayout> {
  defaultLayoutRunner ??= createConnectionsLayoutRunner();
  return defaultLayoutRunner(graph, metrics);
}
