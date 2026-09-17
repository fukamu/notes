import type {
  FullNetworkGeometryShape,
  FullNetworkGraphShape,
} from '@/tests/benchmarks/connections-full-network-baseline-support';

export type BrowserWorkerFeasibilityOutcome =
  | 'completed'
  | 'failed'
  | 'timeout';

export type BrowserWorkerFeasibilityCaseResult = Readonly<{
  schemaVersion: 1;
  fixture: string;
  outcome: BrowserWorkerFeasibilityOutcome;
  timeoutMs: number;
  failure: string | null;
  phasesMs: Readonly<{
    fixtureGeneration: number;
    semanticInput: number;
    workerPreparation: number;
    layoutWall: number;
    validation: number;
  }>;
  input: FullNetworkGraphShape;
  geometry: FullNetworkGeometryShape | null;
  identity: Readonly<{
    nodeIdsMatched: boolean;
    directedEdgesMatched: boolean;
  }>;
  memory: Readonly<{
    beforeLayoutBytes: number | null;
    afterLayoutBytes: number | null;
    afterResetBytes: number | null;
  }>;
  worker: Readonly<{
    beforeResetKind: 'already-reset' | 'reset';
    afterResetKind: 'already-reset' | 'reset';
    afterResetRejectedOperations: number;
    isResetAfter: boolean;
  }>;
}>;

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Reflect.get(input, key);
}

function text(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new TypeError(`${label} must be text`);
  return input;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') {
    throw new TypeError(`${label} must be boolean`);
  }
  return input;
}

function finite(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return input;
}

function count(input: unknown, label: string): number {
  const value = finite(input, label);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return value;
}

function optionalFinite(input: unknown, label: string): number | null {
  return input === null ? null : finite(input, label);
}

function graphShape(input: unknown): FullNetworkGraphShape {
  return {
    nodes: count(field(input, 'nodes'), 'input.nodes'),
    edges: count(field(input, 'edges'), 'input.edges'),
    weaklyConnectedComponents: count(
      field(input, 'weaklyConnectedComponents'),
      'input.weaklyConnectedComponents',
    ),
    isolatedNodes: count(field(input, 'isolatedNodes'), 'input.isolatedNodes'),
    maximumComponentNodes: count(
      field(input, 'maximumComponentNodes'),
      'input.maximumComponentNodes',
    ),
    maximumComponentEdges: count(
      field(input, 'maximumComponentEdges'),
      'input.maximumComponentEdges',
    ),
  };
}

function geometryShape(input: unknown): FullNetworkGeometryShape | null {
  if (input === null) return null;
  return {
    width: finite(field(input, 'width'), 'geometry.width'),
    height: finite(field(input, 'height'), 'geometry.height'),
    nodes: count(field(input, 'nodes'), 'geometry.nodes'),
    ports: count(field(input, 'ports'), 'geometry.ports'),
    edges: count(field(input, 'edges'), 'geometry.edges'),
    sections: count(field(input, 'sections'), 'geometry.sections'),
    points: count(field(input, 'points'), 'geometry.points'),
    pathCharacters: count(
      field(input, 'pathCharacters'),
      'geometry.pathCharacters',
    ),
    geometryWeight: count(
      field(input, 'geometryWeight'),
      'geometry.geometryWeight',
    ),
  };
}

function outcome(input: unknown): BrowserWorkerFeasibilityOutcome {
  if (input === 'completed' || input === 'failed' || input === 'timeout') {
    return input;
  }
  throw new TypeError('outcome must be completed, failed, or timeout');
}

function resetKind(input: unknown, label: string): 'already-reset' | 'reset' {
  if (input === 'already-reset' || input === 'reset') return input;
  throw new TypeError(`${label} must be a reset result kind`);
}

export function decodeBrowserWorkerFeasibilityCaseResult(
  input: unknown,
): BrowserWorkerFeasibilityCaseResult {
  if (field(input, 'schemaVersion') !== 1) {
    throw new TypeError('Unexpected browser Worker feasibility schema');
  }
  const rawFailure = field(input, 'failure');
  if (rawFailure !== null && typeof rawFailure !== 'string') {
    throw new TypeError('failure must be text or null');
  }
  const phases = field(input, 'phasesMs');
  const identity = field(input, 'identity');
  const memory = field(input, 'memory');
  const worker = field(input, 'worker');
  return {
    schemaVersion: 1,
    fixture: text(field(input, 'fixture'), 'fixture'),
    outcome: outcome(field(input, 'outcome')),
    timeoutMs: finite(field(input, 'timeoutMs'), 'timeoutMs'),
    failure: rawFailure,
    phasesMs: {
      fixtureGeneration: finite(
        field(phases, 'fixtureGeneration'),
        'phasesMs.fixtureGeneration',
      ),
      semanticInput: finite(
        field(phases, 'semanticInput'),
        'phasesMs.semanticInput',
      ),
      workerPreparation: finite(
        field(phases, 'workerPreparation'),
        'phasesMs.workerPreparation',
      ),
      layoutWall: finite(field(phases, 'layoutWall'), 'phasesMs.layoutWall'),
      validation: finite(field(phases, 'validation'), 'phasesMs.validation'),
    },
    input: graphShape(field(input, 'input')),
    geometry: geometryShape(field(input, 'geometry')),
    identity: {
      nodeIdsMatched: boolean(
        field(identity, 'nodeIdsMatched'),
        'identity.nodeIdsMatched',
      ),
      directedEdgesMatched: boolean(
        field(identity, 'directedEdgesMatched'),
        'identity.directedEdgesMatched',
      ),
    },
    memory: {
      beforeLayoutBytes: optionalFinite(
        field(memory, 'beforeLayoutBytes'),
        'memory.beforeLayoutBytes',
      ),
      afterLayoutBytes: optionalFinite(
        field(memory, 'afterLayoutBytes'),
        'memory.afterLayoutBytes',
      ),
      afterResetBytes: optionalFinite(
        field(memory, 'afterResetBytes'),
        'memory.afterResetBytes',
      ),
    },
    worker: {
      beforeResetKind: resetKind(
        field(worker, 'beforeResetKind'),
        'worker.beforeResetKind',
      ),
      afterResetKind: resetKind(
        field(worker, 'afterResetKind'),
        'worker.afterResetKind',
      ),
      afterResetRejectedOperations: count(
        field(worker, 'afterResetRejectedOperations'),
        'worker.afterResetRejectedOperations',
      ),
      isResetAfter: boolean(
        field(worker, 'isResetAfter'),
        'worker.isResetAfter',
      ),
    },
  };
}
