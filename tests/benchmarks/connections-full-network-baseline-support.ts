import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import { createConnectionsSvgPath } from '@/lib/graph/connections-path';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { invariant } from '@/lib/shared/invariant';
import {
  decodeClientBenchmarkDistribution,
  summarizeClientBenchmarkSamples,
  type ClientBenchmarkDistribution,
} from '@/tests/benchmarks/client-performance-support';

export type FullNetworkLayoutMode = 'staged' | 'full';

export type FullNetworkGraphShape = Readonly<{
  nodes: number;
  edges: number;
  weaklyConnectedComponents: number;
  isolatedNodes: number;
  maximumComponentNodes: number;
  maximumComponentEdges: number;
}>;

export type FullNetworkGeometryShape = Readonly<{
  width: number;
  height: number;
  nodes: number;
  ports: number;
  edges: number;
  sections: number;
  points: number;
  pathCharacters: number;
  geometryWeight: number;
}>;

export type IsolatedFullNetworkLayoutResult = Readonly<{
  schemaVersion: 1;
  fixture: string;
  mode: FullNetworkLayoutMode;
  status: 'running' | 'completed' | 'failed';
  failure: string | null;
  processNode: string;
  warmupTarget: number;
  measuredTarget: number;
  warmupCompleted: number;
  layoutSamplesMs: readonly number[];
  pathSamplesMs: readonly number[];
  input: FullNetworkGraphShape;
  geometry: FullNetworkGeometryShape | null;
}>;

export type TimedOperation = Readonly<{
  timing: ClientBenchmarkDistribution;
  checksum: number;
}>;

export function connectionsLayoutGraph(
  input: ConnectionsInputModel,
): ConnectionsLayoutGraph {
  return {
    nodes: input.nodes.map(({ cardId: id }) => ({ id })),
    edges: input.edges.map(({ sourceCardId, targetCardId }) => ({
      sourceCardId,
      targetCardId,
    })),
  };
}

export function fullNetworkGraphShape(
  graph: ConnectionsLayoutGraph,
): FullNetworkGraphShape {
  const adjacent = new Map<CardId, CardId[]>(
    graph.nodes.map(({ id }) => [id, []]),
  );
  for (const edge of graph.edges) {
    adjacent.get(edge.sourceCardId)?.push(edge.targetCardId);
    adjacent.get(edge.targetCardId)?.push(edge.sourceCardId);
  }
  const componentByNode = new Map<CardId, number>();
  const componentNodeCounts: number[] = [];
  for (const { id } of graph.nodes) {
    if (componentByNode.has(id)) continue;
    const component = componentNodeCounts.length;
    const queue = [id];
    componentByNode.set(id, component);
    for (let position = 0; position < queue.length; position += 1) {
      const current = queue[position];
      invariant(current, 'Component traversal omitted a node');
      for (const neighbor of adjacent.get(current) ?? []) {
        if (componentByNode.has(neighbor)) continue;
        componentByNode.set(neighbor, component);
        queue.push(neighbor);
      }
    }
    componentNodeCounts.push(queue.length);
  }
  const componentEdgeCounts = Array<number>(componentNodeCounts.length).fill(0);
  for (const edge of graph.edges) {
    const component = componentByNode.get(edge.sourceCardId);
    invariant(component, 'Edge source is outside graph nodes');
    const currentCount = componentEdgeCounts[component] ?? 0;
    componentEdgeCounts[component] = currentCount + 1;
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    weaklyConnectedComponents: componentNodeCounts.length,
    isolatedNodes: componentNodeCounts.filter((count) => count === 1).length,
    maximumComponentNodes: Math.max(0, ...componentNodeCounts),
    maximumComponentEdges: Math.max(0, ...componentEdgeCounts),
  };
}

export function fullNetworkGeometryShape(
  layout: ConnectionsLayout,
  metrics: ConnectionsLayoutMetrics,
): FullNetworkGeometryShape {
  let sections = 0;
  let points = 0;
  let pathCharacters = 0;
  for (const edge of layout.edges) {
    for (const section of edge.sections) {
      const path = createConnectionsSvgPath(section, {
        maximumRadius: 16,
        nodeClearance: metrics.edgeNodeSpacing / 2,
      });
      sections += 1;
      points += section.bendPoints.length + 2;
      pathCharacters += path.d.length;
    }
  }
  const ports = layout.nodes.reduce(
    (total, node) => total + node.ports.length,
    0,
  );
  return {
    width: layout.width,
    height: layout.height,
    nodes: layout.nodes.length,
    ports,
    edges: layout.edges.length,
    sections,
    points,
    pathCharacters,
    geometryWeight: layout.nodes.length + layout.edges.length + points,
  };
}

export function measureOperation(
  warmupIterations: number,
  measuredIterations: number,
  operation: () => number,
): TimedOperation {
  let expectedChecksum: number | undefined;
  for (let index = 0; index < warmupIterations; index += 1) {
    const checksum = operation();
    expectedChecksum ??= checksum;
    invariant(
      checksum === expectedChecksum,
      `Warmup checksum changed from ${expectedChecksum} to ${checksum}`,
    );
  }
  const samples: number[] = [];
  for (let index = 0; index < measuredIterations; index += 1) {
    const started = performance.now();
    const checksum = operation();
    samples.push(performance.now() - started);
    expectedChecksum ??= checksum;
    invariant(
      checksum === expectedChecksum,
      `Measured checksum changed from ${expectedChecksum} to ${checksum}`,
    );
  }
  invariant(expectedChecksum, 'Timed operation did not run');
  return {
    timing: decodeClientBenchmarkDistribution(
      summarizeClientBenchmarkSamples(samples),
    ),
    checksum: expectedChecksum,
  };
}

function objectValue(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Reflect.get(input, key);
}

function finiteNonNegativeNumber(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return input;
}

function count(input: unknown, label: string): number {
  const value = finiteNonNegativeNumber(input, label);
  if (!Number.isSafeInteger(value))
    throw new TypeError(`${label} must be an integer`);
  return value;
}

function numberArray(input: unknown, label: string): readonly number[] {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  return input.map((value, index) =>
    finiteNonNegativeNumber(value, `${label}[${index}]`),
  );
}

function graphShape(input: unknown): FullNetworkGraphShape {
  return {
    nodes: count(objectValue(input, 'nodes'), 'input.nodes'),
    edges: count(objectValue(input, 'edges'), 'input.edges'),
    weaklyConnectedComponents: count(
      objectValue(input, 'weaklyConnectedComponents'),
      'input.weaklyConnectedComponents',
    ),
    isolatedNodes: count(
      objectValue(input, 'isolatedNodes'),
      'input.isolatedNodes',
    ),
    maximumComponentNodes: count(
      objectValue(input, 'maximumComponentNodes'),
      'input.maximumComponentNodes',
    ),
    maximumComponentEdges: count(
      objectValue(input, 'maximumComponentEdges'),
      'input.maximumComponentEdges',
    ),
  };
}

function geometryShape(input: unknown): FullNetworkGeometryShape | null {
  if (input === null) return null;
  return {
    width: finiteNonNegativeNumber(
      objectValue(input, 'width'),
      'geometry.width',
    ),
    height: finiteNonNegativeNumber(
      objectValue(input, 'height'),
      'geometry.height',
    ),
    nodes: count(objectValue(input, 'nodes'), 'geometry.nodes'),
    ports: count(objectValue(input, 'ports'), 'geometry.ports'),
    edges: count(objectValue(input, 'edges'), 'geometry.edges'),
    sections: count(objectValue(input, 'sections'), 'geometry.sections'),
    points: count(objectValue(input, 'points'), 'geometry.points'),
    pathCharacters: count(
      objectValue(input, 'pathCharacters'),
      'geometry.pathCharacters',
    ),
    geometryWeight: count(
      objectValue(input, 'geometryWeight'),
      'geometry.geometryWeight',
    ),
  };
}

export function decodeIsolatedFullNetworkLayoutResult(
  input: unknown,
): IsolatedFullNetworkLayoutResult {
  const schemaVersion = objectValue(input, 'schemaVersion');
  const fixture = objectValue(input, 'fixture');
  const mode = objectValue(input, 'mode');
  const status = objectValue(input, 'status');
  const processNode = objectValue(input, 'processNode');
  const failure = objectValue(input, 'failure');
  if (schemaVersion !== 1) throw new TypeError('Unexpected isolated schema');
  if (typeof fixture !== 'string') throw new TypeError('Missing fixture name');
  if (mode !== 'staged' && mode !== 'full') throw new TypeError('Invalid mode');
  if (status !== 'running' && status !== 'completed' && status !== 'failed') {
    throw new TypeError('Invalid isolated status');
  }
  if (typeof processNode !== 'string')
    throw new TypeError('Missing process node');
  if (failure !== null && typeof failure !== 'string') {
    throw new TypeError('Invalid isolated failure');
  }
  return {
    schemaVersion,
    fixture,
    mode,
    status,
    failure,
    processNode,
    warmupTarget: count(objectValue(input, 'warmupTarget'), 'warmupTarget'),
    measuredTarget: count(
      objectValue(input, 'measuredTarget'),
      'measuredTarget',
    ),
    warmupCompleted: count(
      objectValue(input, 'warmupCompleted'),
      'warmupCompleted',
    ),
    layoutSamplesMs: numberArray(
      objectValue(input, 'layoutSamplesMs'),
      'layoutSamplesMs',
    ),
    pathSamplesMs: numberArray(
      objectValue(input, 'pathSamplesMs'),
      'pathSamplesMs',
    ),
    input: graphShape(objectValue(input, 'input')),
    geometry: geometryShape(objectValue(input, 'geometry')),
  };
}
