import { validate as validateUuid } from 'uuid';
import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '@/lib/codec/core';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
} from '@/lib/domain/identity';
import {
  sameLogoutPurgeGeneration,
  type LogoutPurgeFailureReason,
  type LogoutPurgeGeneration,
} from '@/lib/application/logout-purge';
import { assertNever } from '@/lib/shared/invariant';

export const LOGOUT_COORDINATION_SCHEMA_VERSION =
  'logout-coordination/v1' as const;

declare const tabInstanceIdBrand: unique symbol;

export type TabInstanceId = string & {
  readonly [tabInstanceIdBrand]: 'TabInstanceId';
};

export type LogoutCoordinationMessage =
  | (LogoutPurgeGeneration & {
      readonly schemaVersion: typeof LOGOUT_COORDINATION_SCHEMA_VERSION;
      readonly type: 'purge-request';
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
    })
  | (LogoutPurgeGeneration & {
      readonly schemaVersion: typeof LOGOUT_COORDINATION_SCHEMA_VERSION;
      readonly type: 'peer-quiesced';
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
      readonly peerTabId: TabInstanceId;
    })
  | (LogoutPurgeGeneration & {
      readonly schemaVersion: typeof LOGOUT_COORDINATION_SCHEMA_VERSION;
      readonly type: 'purge-completed';
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
    });

export type LogoutPeerRuntimeState =
  | (LogoutPurgeGeneration & {
      readonly kind: 'active';
      readonly tabId: TabInstanceId;
    })
  | (LogoutPurgeGeneration & {
      readonly kind: 'quiescing';
      readonly tabId: TabInstanceId;
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
    })
  | (LogoutPurgeGeneration & {
      readonly kind: 'quiesced';
      readonly tabId: TabInstanceId;
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
    })
  | (LogoutPurgeGeneration & {
      readonly kind: 'completed';
      readonly tabId: TabInstanceId;
      readonly attempt: number;
      readonly ownerTabId: TabInstanceId;
    });

export type LogoutPeerRuntimeEvent =
  | { readonly type: 'message-received'; readonly input: unknown }
  | { readonly type: 'runtime-released' };

export type LogoutPeerRuntimeAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'stop-runtime' }
  | {
      readonly kind: 'send-message';
      readonly message: Extract<
        LogoutCoordinationMessage,
        { readonly type: 'peer-quiesced' }
      >;
    }
  | { readonly kind: 'purge-completed' };

export type LogoutPeerRuntimeTransition =
  | {
      readonly kind: 'accepted';
      readonly state: LogoutPeerRuntimeState;
      readonly action: LogoutPeerRuntimeAction;
    }
  | {
      readonly kind: 'ignored';
      readonly state: LogoutPeerRuntimeState;
      readonly reason:
        | 'invalid-message'
        | 'generation-mismatch'
        | 'irrelevant-message'
        | 'stale-attempt'
        | 'owner-mismatch'
        | 'duplicate-message'
        | 'runtime-not-quiescing';
    };

export type LogoutPeerAcknowledgements = LogoutPurgeGeneration & {
  readonly attempt: number;
  readonly ownerTabId: TabInstanceId;
  readonly peerTabIds: readonly TabInstanceId[];
};

export type CollectLogoutPeerAcknowledgementDecision =
  | {
      readonly kind: 'accepted';
      readonly acknowledgements: LogoutPeerAcknowledgements;
    }
  | {
      readonly kind: 'ignored';
      readonly acknowledgements: LogoutPeerAcknowledgements;
      readonly reason:
        | 'invalid-message'
        | 'irrelevant-message'
        | 'generation-mismatch'
        | 'attempt-mismatch'
        | 'owner-mismatch'
        | 'self-acknowledgement'
        | 'duplicate-acknowledgement';
    };

export type LogoutCoordinationFailureReason =
  | 'contended'
  | 'timeout'
  | 'adapter-failure'
  | 'unsupported-capability';

const positiveIntegerDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const tabInstanceIdDecoder: Decoder<TabInstanceId> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 36, maxLength: 36 }),
    validateUuid,
    'expected UUID',
  ),
  // The UUID validation above is the runtime proof for this local-only brand.
  (value) => value as TabInstanceId,
);

const messageBaseShape = {
  schemaVersion: literalDecoder(LOGOUT_COORDINATION_SCHEMA_VERSION),
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  sessionId: sessionIdDecoder,
  sessionEpoch: sessionEpochDecoder,
  attempt: positiveIntegerDecoder,
  ownerTabId: tabInstanceIdDecoder,
} as const;

const purgeRequestDecoder = objectDecoder({
  ...messageBaseShape,
  type: literalDecoder('purge-request'),
});
const peerQuiescedDecoder = objectDecoder({
  ...messageBaseShape,
  type: literalDecoder('peer-quiesced'),
  peerTabId: tabInstanceIdDecoder,
});
const purgeCompletedDecoder = objectDecoder({
  ...messageBaseShape,
  type: literalDecoder('purge-completed'),
});

export const logoutCoordinationMessageDecoder: Decoder<LogoutCoordinationMessage> =
  transformDecoder(
    unionDecoder(
      purgeRequestDecoder,
      peerQuiescedDecoder,
      purgeCompletedDecoder,
    ),
    (message): LogoutCoordinationMessage => message,
  );

export function parseTabInstanceId(input: unknown): TabInstanceId {
  return decodeOrThrow(tabInstanceIdDecoder, input, 'TabInstanceId');
}

export function createLogoutPeerRuntimeState(
  generation: LogoutPurgeGeneration,
  tabId: TabInstanceId,
): LogoutPeerRuntimeState {
  return { kind: 'active', ...generationSnapshot(generation), tabId };
}

export function transitionLogoutPeerRuntime(
  state: LogoutPeerRuntimeState,
  event: LogoutPeerRuntimeEvent,
): LogoutPeerRuntimeTransition {
  switch (event.type) {
    case 'runtime-released':
      return runtimeReleased(state);
    case 'message-received': {
      const decoded = logoutCoordinationMessageDecoder.decode(event.input);
      if (!decoded.ok) return ignoredPeer(state, 'invalid-message');
      const message = decoded.value;
      if (!sameLogoutPurgeGeneration(state, message)) {
        return ignoredPeer(state, 'generation-mismatch');
      }
      switch (message.type) {
        case 'purge-request':
          return receivePurgeRequest(state, message);
        case 'purge-completed':
          return receivePurgeCompleted(state, message);
        case 'peer-quiesced':
          return ignoredPeer(state, 'irrelevant-message');
        default:
          return assertNever(
            message,
            'Unsupported logout coordination message',
          );
      }
    }
    default:
      return assertNever(event, 'Unsupported peer runtime event');
  }
}

export function createLogoutPeerAcknowledgements(
  generation: LogoutPurgeGeneration,
  attempt: number,
  ownerTabId: TabInstanceId,
): LogoutPeerAcknowledgements {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('Logout coordination attempt must be a positive integer');
  }
  return {
    ...generationSnapshot(generation),
    attempt,
    ownerTabId,
    peerTabIds: [],
  };
}

export function collectLogoutPeerAcknowledgement(
  acknowledgements: LogoutPeerAcknowledgements,
  input: unknown,
): CollectLogoutPeerAcknowledgementDecision {
  const decoded = logoutCoordinationMessageDecoder.decode(input);
  if (!decoded.ok) return ignoredAck(acknowledgements, 'invalid-message');
  const message = decoded.value;
  if (message.type !== 'peer-quiesced') {
    return ignoredAck(acknowledgements, 'irrelevant-message');
  }
  if (!sameLogoutPurgeGeneration(acknowledgements, message)) {
    return ignoredAck(acknowledgements, 'generation-mismatch');
  }
  if (acknowledgements.attempt !== message.attempt) {
    return ignoredAck(acknowledgements, 'attempt-mismatch');
  }
  if (acknowledgements.ownerTabId !== message.ownerTabId) {
    return ignoredAck(acknowledgements, 'owner-mismatch');
  }
  if (message.peerTabId === acknowledgements.ownerTabId) {
    return ignoredAck(acknowledgements, 'self-acknowledgement');
  }
  if (acknowledgements.peerTabIds.includes(message.peerTabId)) {
    return ignoredAck(acknowledgements, 'duplicate-acknowledgement');
  }
  return {
    kind: 'accepted',
    acknowledgements: {
      ...acknowledgements,
      peerTabIds: [...acknowledgements.peerTabIds, message.peerTabId].sort(),
    },
  };
}

export function createLogoutPurgeRequest(
  generation: LogoutPurgeGeneration,
  attempt: number,
  ownerTabId: TabInstanceId,
): Extract<LogoutCoordinationMessage, { readonly type: 'purge-request' }> {
  validateAttempt(attempt);
  return {
    schemaVersion: LOGOUT_COORDINATION_SCHEMA_VERSION,
    type: 'purge-request',
    ...generationSnapshot(generation),
    attempt,
    ownerTabId,
  };
}

export function createLogoutPurgeCompleted(
  generation: LogoutPurgeGeneration,
  attempt: number,
  ownerTabId: TabInstanceId,
): Extract<LogoutCoordinationMessage, { readonly type: 'purge-completed' }> {
  validateAttempt(attempt);
  return {
    schemaVersion: LOGOUT_COORDINATION_SCHEMA_VERSION,
    type: 'purge-completed',
    ...generationSnapshot(generation),
    attempt,
    ownerTabId,
  };
}

export function logoutCoordinationChannelName(
  generation: Pick<LogoutPurgeGeneration, 'accountId' | 'vaultId'>,
): string {
  return `fukamu:logout:v1:${generation.accountId}:${generation.vaultId}:channel`;
}

export function logoutRuntimeLockName(
  generation: Pick<LogoutPurgeGeneration, 'accountId' | 'vaultId'>,
): string {
  return `fukamu:logout:v1:${generation.accountId}:${generation.vaultId}:runtime`;
}

export function logoutOwnerLockName(
  generation: Pick<LogoutPurgeGeneration, 'accountId' | 'vaultId'>,
): string {
  return `fukamu:logout:v1:${generation.accountId}:${generation.vaultId}:owner`;
}

export function logoutPurgeFailureReasonForCoordination(
  reason: LogoutCoordinationFailureReason,
): Exclude<LogoutPurgeFailureReason, 'interrupted' | 'verification-failed'> {
  switch (reason) {
    case 'contended':
      return 'blocked';
    case 'timeout':
      return 'timeout';
    case 'adapter-failure':
      return 'adapter-failure';
    case 'unsupported-capability':
      return 'unsupported-capability';
    default:
      return assertNever(reason, 'Unsupported coordination failure');
  }
}

function receivePurgeRequest(
  state: LogoutPeerRuntimeState,
  message: Extract<
    LogoutCoordinationMessage,
    { readonly type: 'purge-request' }
  >,
): LogoutPeerRuntimeTransition {
  if (state.kind === 'completed') {
    return ignoredPeer(state, 'duplicate-message');
  }
  if (state.kind === 'active') {
    return {
      kind: 'accepted',
      state: {
        kind: 'quiescing',
        ...generationSnapshot(state),
        tabId: state.tabId,
        attempt: message.attempt,
        ownerTabId: message.ownerTabId,
      },
      action: { kind: 'stop-runtime' },
    };
  }
  if (message.attempt < state.attempt) {
    return ignoredPeer(state, 'stale-attempt');
  }
  if (
    message.attempt === state.attempt &&
    message.ownerTabId !== state.ownerTabId
  ) {
    return ignoredPeer(state, 'owner-mismatch');
  }
  if (state.kind === 'quiescing') {
    if (message.attempt === state.attempt) {
      return ignoredPeer(state, 'duplicate-message');
    }
    return {
      kind: 'accepted',
      state: {
        ...state,
        attempt: message.attempt,
        ownerTabId: message.ownerTabId,
      },
      action: { kind: 'none' },
    };
  }
  const nextState: LogoutPeerRuntimeState = {
    kind: 'quiesced',
    ...generationSnapshot(state),
    tabId: state.tabId,
    attempt: message.attempt,
    ownerTabId: message.ownerTabId,
  };
  return {
    kind: 'accepted',
    state: nextState,
    action: { kind: 'send-message', message: peerAck(nextState) },
  };
}

function receivePurgeCompleted(
  state: LogoutPeerRuntimeState,
  message: Extract<
    LogoutCoordinationMessage,
    { readonly type: 'purge-completed' }
  >,
): LogoutPeerRuntimeTransition {
  if (state.kind === 'active') {
    return ignoredPeer(state, 'irrelevant-message');
  }
  if (message.attempt < state.attempt) {
    return ignoredPeer(state, 'stale-attempt');
  }
  if (message.attempt !== state.attempt) {
    return ignoredPeer(state, 'irrelevant-message');
  }
  if (message.ownerTabId !== state.ownerTabId) {
    return ignoredPeer(state, 'owner-mismatch');
  }
  if (state.kind === 'completed') {
    return ignoredPeer(state, 'duplicate-message');
  }
  return {
    kind: 'accepted',
    state: {
      kind: 'completed',
      ...generationSnapshot(state),
      tabId: state.tabId,
      attempt: state.attempt,
      ownerTabId: state.ownerTabId,
    },
    action: { kind: 'purge-completed' },
  };
}

function runtimeReleased(
  state: LogoutPeerRuntimeState,
): LogoutPeerRuntimeTransition {
  if (state.kind !== 'quiescing') {
    return ignoredPeer(state, 'runtime-not-quiescing');
  }
  const quiesced: LogoutPeerRuntimeState = {
    ...state,
    kind: 'quiesced',
  };
  return {
    kind: 'accepted',
    state: quiesced,
    action: { kind: 'send-message', message: peerAck(quiesced) },
  };
}

function peerAck(
  state: Extract<LogoutPeerRuntimeState, { readonly kind: 'quiesced' }>,
): Extract<LogoutCoordinationMessage, { readonly type: 'peer-quiesced' }> {
  return {
    schemaVersion: LOGOUT_COORDINATION_SCHEMA_VERSION,
    type: 'peer-quiesced',
    ...generationSnapshot(state),
    attempt: state.attempt,
    ownerTabId: state.ownerTabId,
    peerTabId: state.tabId,
  };
}

function generationSnapshot(
  generation: LogoutPurgeGeneration,
): LogoutPurgeGeneration {
  return {
    accountId: generation.accountId,
    vaultId: generation.vaultId,
    sessionId: generation.sessionId,
    sessionEpoch: generation.sessionEpoch,
  };
}

function validateAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('Logout coordination attempt must be a positive integer');
  }
}

function ignoredPeer(
  state: LogoutPeerRuntimeState,
  reason: Extract<LogoutPeerRuntimeTransition, { kind: 'ignored' }>['reason'],
): LogoutPeerRuntimeTransition {
  return { kind: 'ignored', state, reason };
}

function ignoredAck(
  acknowledgements: LogoutPeerAcknowledgements,
  reason: Extract<
    CollectLogoutPeerAcknowledgementDecision,
    { kind: 'ignored' }
  >['reason'],
): CollectLogoutPeerAcknowledgementDecision {
  return { kind: 'ignored', acknowledgements, reason };
}
