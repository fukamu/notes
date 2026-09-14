import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '@/lib/codec/core';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
} from '@/lib/domain/identity';
import { assertNever } from '@/lib/shared/invariant';

export const ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION =
  'account-deletion-handoff/v1' as const;

declare const accountDeletionIdempotencyKeyBrand: unique symbol;
declare const accountDeletionContinuationTokenBrand: unique symbol;

export type AccountDeletionIdempotencyKey = string & {
  readonly [accountDeletionIdempotencyKeyBrand]: 'AccountDeletionIdempotencyKey';
};

export type AccountDeletionContinuationToken = string & {
  readonly [accountDeletionContinuationTokenBrand]: 'AccountDeletionContinuationToken';
};

export type AccountDeletionNonTerminalStatus =
  | {
      readonly kind: 'in-progress';
      readonly continuationToken: AccountDeletionContinuationToken;
    }
  | {
      readonly kind: 'retry-wait';
      readonly retryAt: number;
      readonly continuationToken: AccountDeletionContinuationToken;
    };

export type AccountDeletionServerStatus =
  | AccountDeletionNonTerminalStatus
  | { readonly kind: 'failed' }
  | { readonly kind: 'completed' };

type AccountDeletionHandoffBase = LogoutPurgeGeneration & {
  readonly schemaVersion: typeof ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION;
  readonly revision: number;
  readonly idempotencyKey: AccountDeletionIdempotencyKey;
};

export type AccountDeletionHandoff = AccountDeletionHandoffBase &
  (
    | { readonly kind: 'starting' }
    | {
        readonly kind: 'revoke-pending';
        readonly server: AccountDeletionNonTerminalStatus;
      }
    | {
        readonly kind: 'purge-pending';
        readonly server: AccountDeletionServerStatus;
      }
    | {
        readonly kind: 'server-pending';
        readonly server: AccountDeletionNonTerminalStatus;
      }
  );

export type AccountDeletionHandoffTransition =
  | { readonly kind: 'advanced'; readonly handoff: AccountDeletionHandoff }
  | {
      readonly kind: 'ready-to-clear';
      readonly generation: LogoutPurgeGeneration;
      readonly expectedRevision: number;
      readonly terminalStatus: 'failed' | 'completed';
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-state' | 'revision-exhausted';
    };

export type InspectAccountDeletionHandoffResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly handoff: AccountDeletionHandoff }
  | {
      readonly kind: 'recovery-required';
      readonly reason: 'invalid-marker' | 'unsupported-version';
    };

export type AccountDeletionRunFailure =
  | 'account-mismatch'
  | 'another-deletion-pending'
  | 'authorization-required'
  | 'concurrent-progress-change'
  | 'invalid-state'
  | 'local-purge-failed'
  | 'progress-recovery-required'
  | 'progress-unavailable'
  | 'remote-unavailable'
  | 'request-conflict';

export type AccountDeletionRunResult =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'pending';
      readonly localContent: 'retained' | 'deleted';
      readonly status: AccountDeletionNonTerminalStatus;
    }
  | {
      readonly kind: 'terminal';
      readonly status: 'failed' | 'completed';
    }
  | { readonly kind: 'failed'; readonly reason: AccountDeletionRunFailure };

export type AccountDeletionUiState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'working' }
  | {
      readonly kind: 'pending';
      readonly localContent: 'retained' | 'deleted';
      readonly status: AccountDeletionNonTerminalStatus;
    }
  | { readonly kind: 'error'; readonly reason: AccountDeletionRunFailure }
  | { readonly kind: 'terminal'; readonly status: 'failed' | 'completed' };

export type AccountDeletionUiEvent =
  | { readonly type: 'idle-loaded' }
  | { readonly type: 'confirmation-requested' }
  | { readonly type: 'confirmation-cancelled' }
  | { readonly type: 'work-requested' }
  | {
      readonly type: 'run-finished';
      readonly result: AccountDeletionRunResult;
    };

export type AccountDeletionRemoteResult =
  | { readonly kind: 'accepted'; readonly status: AccountDeletionServerStatus }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'authorization-required'
        | 'request-conflict'
        | 'remote-unavailable';
    };

export type AccountDeletionRemotePort = {
  start(input: {
    readonly idempotencyKey: AccountDeletionIdempotencyKey;
  }): Promise<AccountDeletionRemoteResult>;
  resume(input: {
    readonly continuationToken: AccountDeletionContinuationToken;
  }): Promise<AccountDeletionRemoteResult>;
};

export type AccountDeletionIdempotencyKeyGeneratorPort = {
  create(): unknown;
};

export type AccountDeletionHandoffWrite =
  | { readonly kind: 'create'; readonly handoff: AccountDeletionHandoff }
  | {
      readonly kind: 'replace';
      readonly expectedRevision: number;
      readonly handoff: AccountDeletionHandoff;
    };

export type AccountDeletionHandoffClear = {
  readonly generation: LogoutPurgeGeneration;
  readonly expectedRevision: number;
};

export type AccountDeletionHandoffProgressPort = {
  read(): Promise<unknown>;
  write(input: AccountDeletionHandoffWrite): Promise<unknown>;
  clear(input: AccountDeletionHandoffClear): Promise<unknown>;
};

export type AccountDeletionHandoffRunner = {
  begin(generation: LogoutPurgeGeneration): Promise<AccountDeletionRunResult>;
  recover(): Promise<AccountDeletionRunResult>;
  resumeServer(): Promise<AccountDeletionRunResult>;
};

const base64Url256Decoder = refineDecoder(
  stringDecoder({ minLength: 43, maxLength: 43 }),
  (value) => /^[A-Za-z0-9_-]{43}$/.test(value),
  'expected an unpadded 256-bit base64url value',
);

export const accountDeletionIdempotencyKeyDecoder: Decoder<AccountDeletionIdempotencyKey> =
  transformDecoder(
    base64Url256Decoder,
    // The fixed base64url shape above is the runtime proof for this brand.
    (value) => value as AccountDeletionIdempotencyKey,
  );

export const accountDeletionContinuationTokenDecoder: Decoder<AccountDeletionContinuationToken> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 49, maxLength: 58 }),
      (value) => /^ad1\.[A-Za-z0-9_-]{43}\.(?:0|[1-9][0-9]{0,9})$/.test(value),
      'expected an account deletion continuation token',
    ),
    // The versioned bounded token shape above is the runtime proof for this brand.
    (value) => value as AccountDeletionContinuationToken,
  );

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const revisionDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const generationShape = {
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  sessionId: sessionIdDecoder,
  sessionEpoch: sessionEpochDecoder,
} as const;
const inProgressStatusDecoder = objectDecoder({
  kind: literalDecoder('in-progress'),
  continuationToken: accountDeletionContinuationTokenDecoder,
});
const retryWaitStatusDecoder = objectDecoder({
  kind: literalDecoder('retry-wait'),
  retryAt: timestampDecoder,
  continuationToken: accountDeletionContinuationTokenDecoder,
});

export const accountDeletionNonTerminalStatusDecoder: Decoder<AccountDeletionNonTerminalStatus> =
  unionDecoder(inProgressStatusDecoder, retryWaitStatusDecoder);

export const accountDeletionServerStatusDecoder: Decoder<AccountDeletionServerStatus> =
  unionDecoder(
    inProgressStatusDecoder,
    retryWaitStatusDecoder,
    objectDecoder({ kind: literalDecoder('failed') }),
    objectDecoder({ kind: literalDecoder('completed') }),
  );

export const accountDeletionWireStatusDecoder: Decoder<AccountDeletionServerStatus> =
  unionDecoder(
    transformDecoder(
      objectDecoder({
        status: literalDecoder('in-progress'),
        continuationToken: accountDeletionContinuationTokenDecoder,
      }),
      (value) => ({
        kind: value.status,
        continuationToken: value.continuationToken,
      }),
    ),
    transformDecoder(
      objectDecoder({
        status: literalDecoder('retry-wait'),
        retryAt: timestampDecoder,
        continuationToken: accountDeletionContinuationTokenDecoder,
      }),
      (value) => ({
        kind: value.status,
        retryAt: value.retryAt,
        continuationToken: value.continuationToken,
      }),
    ),
    transformDecoder(
      objectDecoder({ status: literalDecoder('failed') }),
      () => ({
        kind: 'failed' as const,
      }),
    ),
    transformDecoder(
      objectDecoder({ status: literalDecoder('completed') }),
      () => ({ kind: 'completed' as const }),
    ),
  );

const handoffBaseShape = {
  schemaVersion: literalDecoder(ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION),
  ...generationShape,
  revision: revisionDecoder,
  idempotencyKey: accountDeletionIdempotencyKeyDecoder,
} as const;

export const accountDeletionHandoffDecoder: Decoder<AccountDeletionHandoff> =
  unionDecoder(
    objectDecoder({ ...handoffBaseShape, kind: literalDecoder('starting') }),
    objectDecoder({
      ...handoffBaseShape,
      kind: literalDecoder('revoke-pending'),
      server: accountDeletionNonTerminalStatusDecoder,
    }),
    objectDecoder({
      ...handoffBaseShape,
      kind: literalDecoder('purge-pending'),
      server: accountDeletionServerStatusDecoder,
    }),
    objectDecoder({
      ...handoffBaseShape,
      kind: literalDecoder('server-pending'),
      server: accountDeletionNonTerminalStatusDecoder,
    }),
  );

export function createAccountDeletionHandoff(
  generation: LogoutPurgeGeneration,
  idempotencyKey: AccountDeletionIdempotencyKey,
): AccountDeletionHandoff {
  return {
    schemaVersion: ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION,
    ...copyGeneration(generation),
    revision: 1,
    idempotencyKey,
    kind: 'starting',
  };
}

export function planAccountDeletionStartAccepted(
  handoff: AccountDeletionHandoff,
  server: AccountDeletionServerStatus,
): AccountDeletionHandoffTransition {
  if (handoff.kind !== 'starting') return rejected('invalid-state');
  return isTerminalStatus(server)
    ? advance(handoff, { kind: 'purge-pending', server })
    : advance(handoff, { kind: 'revoke-pending', server });
}

export function planAccountDeletionRevokeAccepted(
  handoff: AccountDeletionHandoff,
  server: AccountDeletionServerStatus,
): AccountDeletionHandoffTransition {
  if (handoff.kind !== 'revoke-pending') return rejected('invalid-state');
  return server.kind === 'retry-wait'
    ? advance(handoff, { kind: 'revoke-pending', server })
    : advance(handoff, { kind: 'purge-pending', server });
}

export function planAccountDeletionLocalPurgeCompleted(
  handoff: AccountDeletionHandoff,
): AccountDeletionHandoffTransition {
  if (handoff.kind !== 'purge-pending') return rejected('invalid-state');
  if (isTerminalStatus(handoff.server)) {
    return {
      kind: 'ready-to-clear',
      generation: copyGeneration(handoff),
      expectedRevision: handoff.revision,
      terminalStatus: handoff.server.kind,
    };
  }
  return advance(handoff, {
    kind: 'server-pending',
    server: handoff.server,
  });
}

export function planAccountDeletionServerAccepted(
  handoff: AccountDeletionHandoff,
  server: AccountDeletionServerStatus,
): AccountDeletionHandoffTransition {
  if (handoff.kind !== 'server-pending') return rejected('invalid-state');
  if (isTerminalStatus(server)) {
    return {
      kind: 'ready-to-clear',
      generation: copyGeneration(handoff),
      expectedRevision: handoff.revision,
      terminalStatus: server.kind,
    };
  }
  return advance(handoff, { kind: 'server-pending', server });
}

export function inspectAccountDeletionHandoff(
  input: unknown,
): InspectAccountDeletionHandoffResult {
  if (input === undefined) return { kind: 'none' };
  if (
    isRecord(input) &&
    'schemaVersion' in input &&
    input.schemaVersion !== ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION
  ) {
    return { kind: 'recovery-required', reason: 'unsupported-version' };
  }
  const decoded = accountDeletionHandoffDecoder.decode(input);
  return decoded.ok
    ? { kind: 'loaded', handoff: decoded.value }
    : { kind: 'recovery-required', reason: 'invalid-marker' };
}

export function sameAccountDeletionGeneration(
  left: LogoutPurgeGeneration,
  right: LogoutPurgeGeneration,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

export function accountDeletionUiReducer(
  state: AccountDeletionUiState,
  event: AccountDeletionUiEvent,
): AccountDeletionUiState {
  switch (event.type) {
    case 'idle-loaded':
      return state.kind === 'checking' ? { kind: 'idle' } : state;
    case 'confirmation-requested':
      return state.kind === 'idle' ? { kind: 'confirming' } : state;
    case 'confirmation-cancelled':
      return state.kind === 'confirming' ? { kind: 'idle' } : state;
    case 'work-requested':
      return state.kind === 'confirming' ||
        state.kind === 'pending' ||
        state.kind === 'error'
        ? { kind: 'working' }
        : state;
    case 'run-finished':
      return uiStateFromRunResult(event.result);
    default:
      return assertNever(event, 'Unsupported account deletion UI event');
  }
}

function uiStateFromRunResult(
  result: AccountDeletionRunResult,
): AccountDeletionUiState {
  switch (result.kind) {
    case 'idle':
      return { kind: 'idle' };
    case 'pending':
      return {
        kind: 'pending',
        localContent: result.localContent,
        status: result.status,
      };
    case 'failed':
      return { kind: 'error', reason: result.reason };
    case 'terminal':
      return { kind: 'terminal', status: result.status };
    default:
      return assertNever(result, 'Unsupported account deletion run result');
  }
}

function advance(
  handoff: AccountDeletionHandoff,
  phase:
    | Pick<
        Extract<AccountDeletionHandoff, { kind: 'revoke-pending' }>,
        'kind' | 'server'
      >
    | Pick<
        Extract<AccountDeletionHandoff, { kind: 'purge-pending' }>,
        'kind' | 'server'
      >
    | Pick<
        Extract<AccountDeletionHandoff, { kind: 'server-pending' }>,
        'kind' | 'server'
      >,
): AccountDeletionHandoffTransition {
  const revision = handoff.revision + 1;
  if (!Number.isSafeInteger(revision)) return rejected('revision-exhausted');
  switch (phase.kind) {
    case 'revoke-pending':
      return {
        kind: 'advanced',
        handoff: {
          ...base(handoff, revision),
          kind: phase.kind,
          server: phase.server,
        },
      };
    case 'purge-pending':
      return {
        kind: 'advanced',
        handoff: {
          ...base(handoff, revision),
          kind: phase.kind,
          server: phase.server,
        },
      };
    case 'server-pending':
      return {
        kind: 'advanced',
        handoff: {
          ...base(handoff, revision),
          kind: phase.kind,
          server: phase.server,
        },
      };
    default:
      return assertNever(phase, 'Unsupported account deletion handoff phase');
  }
}

function base(
  handoff: AccountDeletionHandoff,
  revision: number,
): AccountDeletionHandoffBase {
  return {
    schemaVersion: ACCOUNT_DELETION_HANDOFF_SCHEMA_VERSION,
    ...copyGeneration(handoff),
    revision,
    idempotencyKey: handoff.idempotencyKey,
  };
}

function copyGeneration(
  generation: LogoutPurgeGeneration,
): LogoutPurgeGeneration {
  return {
    accountId: generation.accountId,
    vaultId: generation.vaultId,
    sessionId: generation.sessionId,
    sessionEpoch: generation.sessionEpoch,
  };
}

function isTerminalStatus(
  status: AccountDeletionServerStatus,
): status is Extract<
  AccountDeletionServerStatus,
  { kind: 'failed' | 'completed' }
> {
  return status.kind === 'failed' || status.kind === 'completed';
}

function rejected(
  reason: Extract<
    AccountDeletionHandoffTransition,
    { kind: 'rejected' }
  >['reason'],
): AccountDeletionHandoffTransition {
  return { kind: 'rejected', reason };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
