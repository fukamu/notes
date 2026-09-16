import { parseCardId } from '@/lib/domain/id';
import {
  createFullNetworkTopologyFromNumeric,
  fullNetworkLayoutKey,
  validateFullNetworkLayout,
  type FullNetworkLayout,
  type FullNetworkLayoutComponent,
  type FullNetworkLayoutConfiguration,
  type FullNetworkTopology,
} from '@/lib/graph/full-network-layout';

export type FullNetworkLayoutWorkerRequest = Readonly<{
  kind: 'layout-full-network';
  requestId: number;
  topology: FullNetworkTopology;
  configuration: FullNetworkLayoutConfiguration;
}>;

export type FullNetworkLayoutWorkerCompleted = Readonly<{
  kind: 'full-network-layout-completed';
  requestId: number;
  topologyKey: string;
  layout: FullNetworkLayout;
}>;

export type FullNetworkLayoutWorkerFailed = Readonly<{
  kind: 'full-network-layout-failed';
  requestId: number;
  topologyKey: string;
  reason: 'invalid-request' | 'layout-failed';
}>;

export type FullNetworkLayoutWorkerResponse =
  | FullNetworkLayoutWorkerCompleted
  | FullNetworkLayoutWorkerFailed;

function record(input: unknown, label: string): object {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  return input;
}

function value(input: object, key: string): unknown {
  return Reflect.get(input, key);
}

function stringValue(input: object, key: string, label: string): string {
  const candidate = value(input, key);
  if (typeof candidate !== 'string') {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return candidate;
}

function finiteNumber(input: object, key: string, label: string): number {
  const candidate = value(input, key);
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new TypeError(`${label}.${key} must be finite`);
  }
  return candidate;
}

function safeInteger(input: object, key: string, label: string): number {
  const candidate = finiteNumber(input, key, label);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`${label}.${key} must be a non-negative integer`);
  }
  return candidate;
}

function stringArray(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${label} must be a string array`);
  }
  const output: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') {
      throw new TypeError(`${label} must be a string array`);
    }
    output.push(item);
  }
  return output;
}

function uint32Array(input: unknown, label: string): Uint32Array {
  if (!(input instanceof Uint32Array)) {
    throw new TypeError(`${label} must be Uint32Array`);
  }
  return input;
}

function float32Array(input: unknown, label: string): Float32Array {
  if (!(input instanceof Float32Array)) {
    throw new TypeError(`${label} must be Float32Array`);
  }
  return input;
}

function decodeConfiguration(input: unknown): FullNetworkLayoutConfiguration {
  const candidate = record(input, 'configuration');
  const version = safeInteger(candidate, 'version', 'configuration');
  if (version !== 2) throw new TypeError('configuration.version must be 2');
  return {
    version,
    cellWidth: finiteNumber(candidate, 'cellWidth', 'configuration'),
    cellHeight: finiteNumber(candidate, 'cellHeight', 'configuration'),
    componentGap: finiteNumber(candidate, 'componentGap', 'configuration'),
    isolatedComponentGap: finiteNumber(
      candidate,
      'isolatedComponentGap',
      'configuration',
    ),
    shelfAspectRatio: finiteNumber(
      candidate,
      'shelfAspectRatio',
      'configuration',
    ),
  };
}

function decodeTopology(input: unknown): FullNetworkTopology {
  const candidate = record(input, 'topology');
  const structuralKey = stringValue(candidate, 'structuralKey', 'topology');
  const nodeIds = stringArray(
    value(candidate, 'nodeIds'),
    'topology.nodeIds',
  ).map((id) => parseCardId(id));
  const topology = createFullNetworkTopologyFromNumeric(
    nodeIds,
    uint32Array(value(candidate, 'sources'), 'topology.sources'),
    uint32Array(value(candidate, 'targets'), 'topology.targets'),
  );
  if (topology.structuralKey !== structuralKey) {
    throw new Error('topology.structuralKey does not match its identity');
  }
  return topology;
}

export function decodeFullNetworkLayoutWorkerRequest(
  input: unknown,
): FullNetworkLayoutWorkerRequest {
  const candidate = record(input, 'request');
  if (value(candidate, 'kind') !== 'layout-full-network') {
    throw new TypeError('request.kind is invalid');
  }
  return {
    kind: 'layout-full-network',
    requestId: safeInteger(candidate, 'requestId', 'request'),
    topology: decodeTopology(value(candidate, 'topology')),
    configuration: decodeConfiguration(value(candidate, 'configuration')),
  };
}

function decodeComponent(
  input: unknown,
  index: number,
): FullNetworkLayoutComponent {
  const label = `layout.components[${index}]`;
  const candidate = record(input, label);
  const reusedValue = value(candidate, 'reused');
  if (typeof reusedValue !== 'boolean') {
    throw new TypeError(`${label}.reused must be boolean`);
  }
  return {
    structuralKey: stringValue(candidate, 'structuralKey', label),
    nodeIndexes: uint32Array(
      value(candidate, 'nodeIndexes'),
      `${label}.nodeIndexes`,
    ),
    edgeCount: safeInteger(candidate, 'edgeCount', label),
    originX: finiteNumber(candidate, 'originX', label),
    originY: finiteNumber(candidate, 'originY', label),
    width: finiteNumber(candidate, 'width', label),
    height: finiteNumber(candidate, 'height', label),
    reused: reusedValue,
  };
}

function decodeLayout(
  input: unknown,
  topology: FullNetworkTopology,
  configuration: FullNetworkLayoutConfiguration,
): FullNetworkLayout {
  const candidate = record(input, 'layout');
  const componentValues = value(candidate, 'components');
  if (!Array.isArray(componentValues)) {
    throw new TypeError('layout.components must be an array');
  }
  const layout: FullNetworkLayout = {
    layoutKey: stringValue(candidate, 'layoutKey', 'layout'),
    topologyKey: stringValue(candidate, 'topologyKey', 'layout'),
    nodeCount: safeInteger(candidate, 'nodeCount', 'layout'),
    edgeCount: safeInteger(candidate, 'edgeCount', 'layout'),
    width: finiteNumber(candidate, 'width', 'layout'),
    height: finiteNumber(candidate, 'height', 'layout'),
    x: float32Array(value(candidate, 'x'), 'layout.x'),
    y: float32Array(value(candidate, 'y'), 'layout.y'),
    componentIndex: uint32Array(
      value(candidate, 'componentIndex'),
      'layout.componentIndex',
    ),
    components: componentValues.map(decodeComponent),
    reusedComponentCount: safeInteger(
      candidate,
      'reusedComponentCount',
      'layout',
    ),
  };
  if (layout.layoutKey !== fullNetworkLayoutKey(topology, configuration)) {
    throw new Error('layout.layoutKey does not match its request');
  }
  validateFullNetworkLayout(topology, layout);
  return layout;
}

export function decodeFullNetworkLayoutWorkerResponse(
  input: unknown,
  expected: Readonly<{
    requestId: number;
    topology: FullNetworkTopology;
    configuration: FullNetworkLayoutConfiguration;
  }>,
): FullNetworkLayoutWorkerResponse {
  const candidate = record(input, 'response');
  const requestId = safeInteger(candidate, 'requestId', 'response');
  const topologyKey = stringValue(candidate, 'topologyKey', 'response');
  if (
    requestId !== expected.requestId ||
    topologyKey !== expected.topology.structuralKey
  ) {
    throw new Error('Worker response does not match its request');
  }
  const kind = value(candidate, 'kind');
  if (kind === 'full-network-layout-completed') {
    return {
      kind,
      requestId,
      topologyKey,
      layout: decodeLayout(
        value(candidate, 'layout'),
        expected.topology,
        expected.configuration,
      ),
    };
  }
  if (kind === 'full-network-layout-failed') {
    const reason = value(candidate, 'reason');
    if (reason !== 'invalid-request' && reason !== 'layout-failed') {
      throw new TypeError('response.reason is invalid');
    }
    return { kind, requestId, topologyKey, reason };
  }
  throw new TypeError('response.kind is invalid');
}
