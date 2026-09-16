import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  sameFullNetworkTopology,
  type FullNetworkLayout,
  type FullNetworkLayoutConfiguration,
  type FullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  decodeFullNetworkLayoutWorkerResponse,
  type FullNetworkLayoutWorkerRequest,
} from '@/lib/graph/full-network-layout-protocol';

export type FullNetworkReadyLayout = Readonly<{
  topology: FullNetworkTopology;
  layout: FullNetworkLayout;
}>;

type FullNetworkPendingRequest = Readonly<{
  requestId: number;
  topology: FullNetworkTopology;
  configuration: FullNetworkLayoutConfiguration;
}>;

export type FullNetworkLayoutControllerState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      readonly request: FullNetworkPendingRequest;
    }
  | {
      readonly status: 'refreshing';
      readonly request: FullNetworkPendingRequest;
      readonly ready: FullNetworkReadyLayout;
    }
  | {
      readonly status: 'ready';
      readonly ready: FullNetworkReadyLayout;
    }
  | {
      readonly status: 'error';
      readonly topology: FullNetworkTopology;
      readonly ready: FullNetworkReadyLayout | null;
      readonly reason:
        | 'worker-failure'
        | 'worker-rejected'
        | 'invalid-response';
    }
  | { readonly status: 'destroyed' };

export type FullNetworkLayoutTransitionEvent =
  | {
      readonly type: 'topology-observed';
      readonly topology: FullNetworkTopology;
      readonly requestId: number;
      readonly configuration: FullNetworkLayoutConfiguration;
    }
  | {
      readonly type: 'retry-requested';
      readonly requestId: number;
      readonly configuration: FullNetworkLayoutConfiguration;
    }
  | {
      readonly type: 'request-completed';
      readonly requestId: number;
      readonly topology: FullNetworkTopology;
      readonly layout: FullNetworkLayout;
    }
  | {
      readonly type: 'request-failed';
      readonly requestId: number;
      readonly reason:
        | 'worker-failure'
        | 'worker-rejected'
        | 'invalid-response';
    }
  | { readonly type: 'destroyed' };

export type FullNetworkLayoutTransition = Readonly<{
  state: FullNetworkLayoutControllerState;
  command:
    | { readonly kind: 'none' }
    | {
        readonly kind: 'start';
        readonly cancelInFlight: boolean;
        readonly request: FullNetworkPendingRequest;
      }
    | { readonly kind: 'cancel-and-destroy' };
}>;

export type FullNetworkLayoutExecutionPort = Readonly<{
  scope: VaultNotesScope;
  run: (request: FullNetworkLayoutWorkerRequest) => Promise<unknown>;
  cancel: () => void;
  destroy: () => void;
}>;

export type FullNetworkLayoutController = Readonly<{
  getState: () => FullNetworkLayoutControllerState;
  subscribe: (listener: () => void) => () => void;
  update: (input: ConnectionsInputModel) => void;
  retry: () => void;
  destroy: () => void;
}>;

function currentReady(
  state: FullNetworkLayoutControllerState,
): FullNetworkReadyLayout | null {
  switch (state.status) {
    case 'ready':
    case 'refreshing':
      return state.ready;
    case 'error':
      return state.ready;
    case 'idle':
    case 'loading':
    case 'destroyed':
      return null;
  }
}

function requestedTopology(
  state: FullNetworkLayoutControllerState,
): FullNetworkTopology | null {
  switch (state.status) {
    case 'loading':
    case 'refreshing':
      return state.request.topology;
    case 'error':
      return state.topology;
    case 'ready':
      return state.ready.topology;
    case 'idle':
    case 'destroyed':
      return null;
  }
}

function activeRequest(
  state: FullNetworkLayoutControllerState,
): FullNetworkPendingRequest | null {
  return state.status === 'loading' || state.status === 'refreshing'
    ? state.request
    : null;
}

function startRequest(
  state: FullNetworkLayoutControllerState,
  request: FullNetworkPendingRequest,
): FullNetworkLayoutTransition {
  const ready = currentReady(state);
  return {
    state: ready
      ? { status: 'refreshing', request, ready }
      : { status: 'loading', request },
    command: {
      kind: 'start',
      cancelInFlight: activeRequest(state) !== null,
      request,
    },
  };
}

export function transitionFullNetworkLayout(
  state: FullNetworkLayoutControllerState,
  event: FullNetworkLayoutTransitionEvent,
): FullNetworkLayoutTransition {
  if (state.status === 'destroyed') {
    return { state, command: { kind: 'none' } };
  }
  switch (event.type) {
    case 'topology-observed': {
      const requested = requestedTopology(state);
      if (requested && sameFullNetworkTopology(requested, event.topology)) {
        return { state, command: { kind: 'none' } };
      }
      return startRequest(state, {
        requestId: event.requestId,
        topology: event.topology,
        configuration: event.configuration,
      });
    }
    case 'retry-requested': {
      if (state.status !== 'error') {
        return { state, command: { kind: 'none' } };
      }
      return startRequest(state, {
        requestId: event.requestId,
        topology: state.topology,
        configuration: event.configuration,
      });
    }
    case 'request-completed': {
      const request = activeRequest(state);
      if (
        !request ||
        request.requestId !== event.requestId ||
        !sameFullNetworkTopology(request.topology, event.topology)
      ) {
        return { state, command: { kind: 'none' } };
      }
      return {
        state: {
          status: 'ready',
          ready: { topology: event.topology, layout: event.layout },
        },
        command: { kind: 'none' },
      };
    }
    case 'request-failed': {
      const request = activeRequest(state);
      if (!request || request.requestId !== event.requestId) {
        return { state, command: { kind: 'none' } };
      }
      return {
        state: {
          status: 'error',
          topology: request.topology,
          ready: currentReady(state),
          reason: event.reason,
        },
        command: { kind: 'none' },
      };
    }
    case 'destroyed':
      return {
        state: { status: 'destroyed' },
        command: { kind: 'cancel-and-destroy' },
      };
  }
}

function sameScope(left: VaultNotesScope, right: VaultNotesScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

export function createFullNetworkLayoutController(input: {
  readonly scope: VaultNotesScope;
  readonly execution: FullNetworkLayoutExecutionPort;
  readonly configuration?: FullNetworkLayoutConfiguration;
}): FullNetworkLayoutController {
  if (!sameScope(input.scope, input.execution.scope)) {
    throw new Error('Full-network layout execution scope mismatch');
  }
  const configuration =
    input.configuration ?? defaultFullNetworkLayoutConfiguration;
  let state: FullNetworkLayoutControllerState = { status: 'idle' };
  let nextRequestId = 1;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const apply = (transition: FullNetworkLayoutTransition): void => {
    if (transition.state !== state) {
      state = transition.state;
      emit();
    }
    if (transition.command.kind === 'cancel-and-destroy') {
      input.execution.cancel();
      input.execution.destroy();
      return;
    }
    if (transition.command.kind !== 'start') return;
    if (transition.command.cancelInFlight) input.execution.cancel();
    const request: FullNetworkLayoutWorkerRequest = {
      kind: 'layout-full-network',
      ...transition.command.request,
    };
    void input.execution.run(request).then(
      (candidate) => {
        try {
          const response = decodeFullNetworkLayoutWorkerResponse(
            candidate,
            request,
          );
          apply(
            response.kind === 'full-network-layout-completed'
              ? transitionFullNetworkLayout(state, {
                  type: 'request-completed',
                  requestId: response.requestId,
                  topology: request.topology,
                  layout: response.layout,
                })
              : transitionFullNetworkLayout(state, {
                  type: 'request-failed',
                  requestId: response.requestId,
                  reason: 'worker-rejected',
                }),
          );
        } catch {
          apply(
            transitionFullNetworkLayout(state, {
              type: 'request-failed',
              requestId: request.requestId,
              reason: 'invalid-response',
            }),
          );
        }
      },
      () => {
        apply(
          transitionFullNetworkLayout(state, {
            type: 'request-failed',
            requestId: request.requestId,
            reason: 'worker-failure',
          }),
        );
      },
    );
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (model) => {
      const topology = createFullNetworkTopology(model);
      apply(
        transitionFullNetworkLayout(state, {
          type: 'topology-observed',
          topology,
          requestId: nextRequestId,
          configuration,
        }),
      );
      nextRequestId += 1;
    },
    retry: () => {
      apply(
        transitionFullNetworkLayout(state, {
          type: 'retry-requested',
          requestId: nextRequestId,
          configuration,
        }),
      );
      nextRequestId += 1;
    },
    destroy: () => {
      apply(transitionFullNetworkLayout(state, { type: 'destroyed' }));
      listeners.clear();
    },
  };
}
