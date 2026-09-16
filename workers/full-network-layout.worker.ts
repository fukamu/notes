import {
  layoutFullNetworkTopology,
  type FullNetworkLayoutConfiguration,
  type FullNetworkLayoutSnapshot,
  type FullNetworkTopology,
} from '../lib/graph/full-network-layout';
import {
  decodeFullNetworkLayoutWorkerRequest,
  type FullNetworkLayoutWorkerFailed,
  type FullNetworkLayoutWorkerResponse,
} from '../lib/graph/full-network-layout-protocol';

type LayoutWorkerScope = Readonly<{
  addEventListener: (
    type: 'message',
    listener: (event: Readonly<{ data: unknown }>) => void,
  ) => void;
  postMessage: (message: FullNetworkLayoutWorkerResponse) => void;
}>;

function isLayoutWorkerScope(input: unknown): input is LayoutWorkerScope {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'addEventListener') === 'function' &&
    typeof Reflect.get(input, 'postMessage') === 'function'
  );
}

const candidateScope: unknown = globalThis;
if (!isLayoutWorkerScope(candidateScope)) {
  throw new Error('Full-network worker loaded outside a WorkerGlobalScope');
}
const workerScope = candidateScope;
let previous: FullNetworkLayoutSnapshot | undefined;

function fallbackIdentity(input: unknown): Readonly<{
  requestId: number;
  topologyKey: string;
}> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { requestId: 0, topologyKey: '' };
  }
  const requestId: unknown = Reflect.get(input, 'requestId');
  const topology: unknown = Reflect.get(input, 'topology');
  const topologyKey: unknown =
    typeof topology === 'object' && topology !== null
      ? Reflect.get(topology, 'structuralKey')
      : undefined;
  return {
    requestId:
      typeof requestId === 'number' &&
      Number.isSafeInteger(requestId) &&
      requestId >= 0
        ? requestId
        : 0,
    topologyKey: typeof topologyKey === 'string' ? topologyKey : '',
  };
}

function execute(
  request: Readonly<{
    requestId: number;
    topology: FullNetworkTopology;
    configuration: FullNetworkLayoutConfiguration;
  }>,
): FullNetworkLayoutWorkerResponse {
  let response: FullNetworkLayoutWorkerResponse;
  try {
    const layout = layoutFullNetworkTopology(
      request.topology,
      request.configuration,
      previous,
    );
    previous = { topology: request.topology, layout };
    response = {
      kind: 'full-network-layout-completed',
      requestId: request.requestId,
      topologyKey: request.topology.structuralKey,
      layout,
    };
  } catch {
    response = {
      kind: 'full-network-layout-failed',
      requestId: request.requestId,
      topologyKey: request.topology.structuralKey,
      reason: 'layout-failed',
    };
  }
  return response;
}

workerScope.addEventListener('message', (event): void => {
  try {
    const request = decodeFullNetworkLayoutWorkerRequest(event.data);
    workerScope.postMessage(execute(request));
  } catch {
    const identity = fallbackIdentity(event.data);
    const response: FullNetworkLayoutWorkerFailed = {
      kind: 'full-network-layout-failed',
      ...identity,
      reason: 'invalid-request',
    };
    workerScope.postMessage(response);
  }
});
