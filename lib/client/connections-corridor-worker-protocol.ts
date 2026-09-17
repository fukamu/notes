import { parseCardId } from '@/lib/domain/id';
import type { ConnectionsCorridorOptions } from '@/lib/graph/connections-corridor-layout';
import { CONNECTIONS_LAYOUT_POLICY_REVISION } from '@/lib/graph/connections-layout-policy';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
  ConnectionsLayoutPort,
  ConnectionsLayoutSection,
  LayoutPoint,
} from '@/lib/graph/elk-layout';

export type ConnectionsCorridorWorkerRequest = Readonly<{
  type: 'layout';
  requestId: number;
  generation: number;
  policyRevision: string;
  graph: ConnectionsLayoutGraph;
  metrics: ConnectionsLayoutMetrics;
  options: ConnectionsCorridorOptions;
}>;

export type ConnectionsCorridorWorkerResponse =
  | Readonly<{
      type: 'ready';
      policyRevision: string;
    }>
  | Readonly<{
      type: 'completed';
      requestId: number;
      generation: number;
      policyRevision: string;
      workerLayoutMs: number;
      layout: unknown;
    }>
  | Readonly<{
      type: 'failed';
      requestId: number;
      generation: number;
      policyRevision: string;
      failure: string;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  const decoded = finite(value, label);
  if (decoded <= 0) throw new RangeError(`${label} must be positive`);
  return decoded;
}

function nonNegative(value: unknown, label: string): number {
  const decoded = finite(value, label);
  if (decoded < 0) throw new RangeError(`${label} must be non-negative`);
  return decoded;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  return value;
}

function decodePoint(value: unknown, label: string): LayoutPoint {
  const input = record(value, label);
  return {
    x: nonNegative(input.x, `${label}.x`),
    y: nonNegative(input.y, `${label}.y`),
  };
}

function decodeMetrics(value: unknown): ConnectionsLayoutMetrics {
  const input = record(value, 'corridor request metrics');
  const padding = record(input.padding, 'corridor request metrics.padding');
  return {
    nodeWidth: positive(input.nodeWidth, 'corridor request metrics.nodeWidth'),
    nodeHeight: positive(
      input.nodeHeight,
      'corridor request metrics.nodeHeight',
    ),
    portSize: positive(input.portSize, 'corridor request metrics.portSize'),
    componentSpacing: positive(
      input.componentSpacing,
      'corridor request metrics.componentSpacing',
    ),
    nodeSpacing: positive(
      input.nodeSpacing,
      'corridor request metrics.nodeSpacing',
    ),
    edgeNodeSpacing: positive(
      input.edgeNodeSpacing,
      'corridor request metrics.edgeNodeSpacing',
    ),
    layerSpacing: positive(
      input.layerSpacing,
      'corridor request metrics.layerSpacing',
    ),
    edgeLayerSpacing: positive(
      input.edgeLayerSpacing,
      'corridor request metrics.edgeLayerSpacing',
    ),
    padding: {
      top: positive(padding.top, 'corridor request metrics.padding.top'),
      right: positive(padding.right, 'corridor request metrics.padding.right'),
      bottom: positive(
        padding.bottom,
        'corridor request metrics.padding.bottom',
      ),
      left: positive(padding.left, 'corridor request metrics.padding.left'),
    },
  };
}

function decodeGraph(value: unknown): ConnectionsLayoutGraph {
  const input = record(value, 'corridor request graph');
  const nodes = array(input.nodes, 'corridor request graph.nodes').map(
    (value, index) => {
      const node = record(value, `corridor request graph.nodes[${index}]`);
      return { id: parseCardId(node.id) };
    },
  );
  const nodeIds = new Set(nodes.map(({ id }) => id));
  if (nodeIds.size !== nodes.length) {
    throw new Error('corridor request graph contains duplicate nodes');
  }
  const edges = array(input.edges, 'corridor request graph.edges').map(
    (value, index) => {
      const edge = record(value, `corridor request graph.edges[${index}]`);
      const sourceCardId = parseCardId(edge.sourceCardId);
      const targetCardId = parseCardId(edge.targetCardId);
      if (!nodeIds.has(sourceCardId) || !nodeIds.has(targetCardId)) {
        throw new Error(
          `corridor request edge ${index} has a missing endpoint`,
        );
      }
      return { sourceCardId, targetCardId };
    },
  );
  return { nodes, edges };
}

export function decodeConnectionsCorridorWorkerRequest(
  value: unknown,
): ConnectionsCorridorWorkerRequest {
  const input = record(value, 'corridor worker request');
  if (input.type !== 'layout') {
    throw new TypeError('corridor worker request type must be layout');
  }
  const policyRevision = text(
    input.policyRevision,
    'corridor worker request policyRevision',
  );
  if (policyRevision !== CONNECTIONS_LAYOUT_POLICY_REVISION) {
    throw new Error('corridor worker request policy revision is incompatible');
  }
  const options = record(input.options, 'corridor worker request options');
  return {
    type: 'layout',
    requestId: safeInteger(
      input.requestId,
      'corridor worker request requestId',
    ),
    generation: safeInteger(
      input.generation,
      'corridor worker request generation',
    ),
    policyRevision,
    graph: decodeGraph(input.graph),
    metrics: decodeMetrics(input.metrics),
    options: {
      laneSpacing: positive(
        options.laneSpacing,
        'corridor worker request options.laneSpacing',
      ),
    },
  };
}

export function decodeConnectionsCorridorWorkerResponse(
  value: unknown,
): ConnectionsCorridorWorkerResponse {
  const input = record(value, 'corridor worker response');
  const policyRevision = text(
    input.policyRevision,
    'corridor worker response policyRevision',
  );
  if (input.type === 'ready') return { type: 'ready', policyRevision };
  const requestId = safeInteger(
    input.requestId,
    'corridor worker response requestId',
  );
  const generation = safeInteger(
    input.generation,
    'corridor worker response generation',
  );
  if (input.type === 'completed') {
    return {
      type: 'completed',
      requestId,
      generation,
      policyRevision,
      workerLayoutMs: nonNegative(
        input.workerLayoutMs,
        'corridor worker response workerLayoutMs',
      ),
      layout: input.layout,
    };
  }
  if (input.type === 'failed') {
    return {
      type: 'failed',
      requestId,
      generation,
      policyRevision,
      failure: text(input.failure, 'corridor worker response failure'),
    };
  }
  throw new TypeError('corridor worker response has an unknown type');
}

function decodePort(
  value: unknown,
  label: string,
  metrics: ConnectionsLayoutMetrics,
): ConnectionsLayoutPort {
  const input = record(value, label);
  const side = input.side;
  if (side !== 'NORTH' && side !== 'SOUTH') {
    throw new TypeError(`${label}.side must be NORTH or SOUTH`);
  }
  const width = positive(input.width, `${label}.width`);
  const height = positive(input.height, `${label}.height`);
  if (width !== metrics.portSize || height !== metrics.portSize) {
    throw new Error(`${label} does not match the requested port size`);
  }
  return {
    id: text(input.id, `${label}.id`),
    x: nonNegative(input.x, `${label}.x`),
    y: nonNegative(input.y, `${label}.y`),
    width,
    height,
    side,
  };
}

function decodeSection(
  value: unknown,
  label: string,
): ConnectionsLayoutSection {
  const input = record(value, label);
  const incomingShape = text(input.incomingShape, `${label}.incomingShape`);
  const outgoingShape = text(input.outgoingShape, `${label}.outgoingShape`);
  return {
    id: text(input.id, `${label}.id`),
    startPoint: decodePoint(input.startPoint, `${label}.startPoint`),
    bendPoints: array(input.bendPoints, `${label}.bendPoints`).map(
      (point, index) => decodePoint(point, `${label}.bendPoints[${index}]`),
    ),
    endPoint: decodePoint(input.endPoint, `${label}.endPoint`),
    incomingShape,
    outgoingShape,
  };
}

export function decodeConnectionsCorridorLayout(
  value: unknown,
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
): ConnectionsLayout {
  const input = record(value, 'corridor worker layout');
  const width = positive(input.width, 'corridor worker layout.width');
  const height = positive(input.height, 'corridor worker layout.height');
  const rawNodes = array(input.nodes, 'corridor worker layout.nodes');
  const rawEdges = array(input.edges, 'corridor worker layout.edges');
  if (rawNodes.length !== graph.nodes.length) {
    throw new Error('corridor worker changed the node count');
  }
  if (rawEdges.length !== graph.edges.length) {
    throw new Error('corridor worker changed the edge count');
  }

  const portOwners = new Map<string, ReturnType<typeof parseCardId>>();
  const nodes = rawNodes.map((value, nodeIndex) => {
    const label = `corridor worker layout.nodes[${nodeIndex}]`;
    const node = record(value, label);
    const id = parseCardId(node.id);
    if (id !== graph.nodes[nodeIndex]?.id) {
      throw new Error(`corridor worker changed node order at ${nodeIndex}`);
    }
    const nodeWidth = positive(node.width, `${label}.width`);
    const nodeHeight = positive(node.height, `${label}.height`);
    if (nodeWidth !== metrics.nodeWidth || nodeHeight !== metrics.nodeHeight) {
      throw new Error(`${label} does not match the requested node size`);
    }
    const ports = array(node.ports, `${label}.ports`).map((port, portIndex) => {
      const decoded = decodePort(port, `${label}.ports[${portIndex}]`, metrics);
      if (portOwners.has(decoded.id)) {
        throw new Error(`corridor worker duplicated port ${decoded.id}`);
      }
      portOwners.set(decoded.id, id);
      return decoded;
    });
    const x = nonNegative(node.x, `${label}.x`);
    const y = nonNegative(node.y, `${label}.y`);
    if (x + nodeWidth > width || y + nodeHeight > height) {
      throw new Error(`${label} is outside the layout bounds`);
    }
    return { id, x, y, width: nodeWidth, height: nodeHeight, ports };
  });

  if (portOwners.size !== graph.edges.length * 2) {
    throw new Error('corridor worker did not return two ports per edge');
  }
  const edges = rawEdges.map((value, edgeIndex) => {
    const label = `corridor worker layout.edges[${edgeIndex}]`;
    const edge = record(value, label);
    const inputEdge = graph.edges[edgeIndex];
    if (!inputEdge) throw new Error(`corridor worker added edge ${edgeIndex}`);
    const sourceCardId = parseCardId(edge.sourceCardId);
    const targetCardId = parseCardId(edge.targetCardId);
    const id = text(edge.id, `${label}.id`);
    const sourcePortId = text(edge.sourcePortId, `${label}.sourcePortId`);
    const targetPortId = text(edge.targetPortId, `${label}.targetPortId`);
    if (
      sourceCardId !== inputEdge.sourceCardId ||
      targetCardId !== inputEdge.targetCardId ||
      id !== `edge-${edgeIndex}` ||
      sourcePortId !== `port-${edgeIndex}-source` ||
      targetPortId !== `port-${edgeIndex}-target`
    ) {
      throw new Error(`corridor worker changed edge order at ${edgeIndex}`);
    }
    if (
      portOwners.get(sourcePortId) !== sourceCardId ||
      portOwners.get(targetPortId) !== targetCardId
    ) {
      throw new Error(`corridor worker attached edge ${edgeIndex} incorrectly`);
    }
    const rawSections = array(edge.sections, `${label}.sections`);
    if (rawSections.length !== 1) {
      throw new Error(
        `corridor worker edge ${edgeIndex} must have one section`,
      );
    }
    const section = decodeSection(rawSections[0], `${label}.sections[0]`);
    if (
      section.id !== `edge-${edgeIndex}-section-0` ||
      section.incomingShape !== sourcePortId ||
      section.outgoingShape !== targetPortId
    ) {
      throw new Error(`corridor worker changed section ${edgeIndex}`);
    }
    for (const point of [
      section.startPoint,
      ...section.bendPoints,
      section.endPoint,
    ]) {
      if (point.x > width || point.y > height) {
        throw new Error(
          `corridor worker edge ${edgeIndex} leaves layout bounds`,
        );
      }
    }
    return {
      sourceCardId,
      targetCardId,
      id,
      sourcePortId,
      targetPortId,
      sections: [section],
    };
  });
  return { width, height, nodes, edges };
}
