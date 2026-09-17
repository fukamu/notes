import { layoutConnectionsCorridors } from '@/lib/graph/connections-corridor-layout';
import { CONNECTIONS_LAYOUT_POLICY_REVISION } from '@/lib/graph/connections-layout-policy';
import {
  decodeConnectionsCorridorWorkerRequest,
  type ConnectionsCorridorWorkerResponse,
} from '@/lib/client/connections-corridor-worker-protocol';

type CorridorWorkerScope = Readonly<{
  addEventListener: (
    type: 'message',
    listener: (event: Readonly<{ data: unknown }>) => void,
  ) => void;
  postMessage: (message: ConnectionsCorridorWorkerResponse) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCorridorWorkerScope(value: unknown): value is CorridorWorkerScope {
  return (
    isRecord(value) &&
    typeof value.addEventListener === 'function' &&
    typeof value.postMessage === 'function'
  );
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : message.slice(0, 2_000);
}

const candidateScope: unknown = globalThis;
if (!isCorridorWorkerScope(candidateScope)) {
  throw new Error('Connections corridor Worker scope is unavailable');
}
const workerScope = candidateScope;

workerScope.addEventListener('message', (event) => {
  let requestId = 0;
  let generation = 0;
  try {
    const request = decodeConnectionsCorridorWorkerRequest(event.data);
    requestId = request.requestId;
    generation = request.generation;
    const started = performance.now();
    const layout = layoutConnectionsCorridors(
      request.graph,
      request.metrics,
      request.options,
    );
    const workerLayoutMs = performance.now() - started;
    workerScope.postMessage({
      type: 'completed',
      requestId,
      generation,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      workerLayoutMs,
      layout,
    });
  } catch (error: unknown) {
    workerScope.postMessage({
      type: 'failed',
      requestId,
      generation,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      failure: failureMessage(error),
    });
  }
});

workerScope.postMessage({
  type: 'ready',
  policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
});
