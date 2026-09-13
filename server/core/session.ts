import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type SessionEpoch,
  type SessionId,
  type SessionToken,
  type VaultContext,
  type VaultId,
} from '../../lib/domain/identity';

const timestampDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export type SessionRevocationReason = 'logout' | 'rotated' | 'security';

export type ActiveSession = {
  readonly kind: 'active';
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly sessionEpoch: SessionEpoch;
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type RevokedSession = {
  readonly kind: 'revoked';
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly sessionEpoch: SessionEpoch;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number;
  readonly reason: SessionRevocationReason;
};

export type SessionRecord = ActiveSession | RevokedSession;

const sessionBaseShape = {
  sessionId: sessionIdDecoder,
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  sessionEpoch: sessionEpochDecoder,
  issuedAt: timestampDecoder,
  expiresAt: timestampDecoder,
} as const;

const activeSessionDecoder = objectDecoder({
  kind: literalDecoder('active'),
  ...sessionBaseShape,
});

const revokedSessionDecoder = objectDecoder({
  kind: literalDecoder('revoked'),
  ...sessionBaseShape,
  revokedAt: timestampDecoder,
  reason: unionDecoder(
    literalDecoder('logout'),
    literalDecoder('rotated'),
    literalDecoder('security'),
  ),
});

const sessionRecordShapeDecoder = refineDecoder(
  unionDecoder(activeSessionDecoder, revokedSessionDecoder),
  (record) =>
    record.expiresAt > record.issuedAt &&
    (record.kind === 'active' || record.revokedAt >= record.issuedAt),
  'expected a valid session timeline',
);

export const sessionRecordDecoder: Decoder<SessionRecord> = transformDecoder(
  sessionRecordShapeDecoder,
  (record): SessionRecord => {
    const base = {
      sessionId: record.sessionId,
      accountId: record.accountId,
      vaultId: record.vaultId,
      sessionEpoch: record.sessionEpoch,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    };
    return record.kind === 'active'
      ? { kind: 'active', ...base }
      : {
          kind: 'revoked',
          ...base,
          revokedAt: record.revokedAt,
          reason: record.reason,
        };
  },
);

export type CreateSessionDecision =
  | { readonly kind: 'created'; readonly session: ActiveSession }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-lifetime' };

export function createActiveSession(input: {
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly sessionEpoch: SessionEpoch;
  readonly issuedAt: number;
  readonly expiresAt: number;
}): CreateSessionDecision {
  if (
    !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.issuedAt < 0 ||
    input.expiresAt <= input.issuedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-lifetime' };
  }
  return { kind: 'created', session: { kind: 'active', ...input } };
}

export type SessionAccessDecision =
  | { readonly kind: 'anonymous'; readonly reason: 'missing-session' }
  | {
      readonly kind: 'denied';
      readonly reason: 'revoked' | 'expired' | 'invalid-clock';
    }
  | { readonly kind: 'authenticated'; readonly context: VaultContext };

export function authorizeSession(
  session: SessionRecord | undefined,
  now: number,
): SessionAccessDecision {
  if (!session) return { kind: 'anonymous', reason: 'missing-session' };
  if (!Number.isSafeInteger(now) || now < 0) {
    return { kind: 'denied', reason: 'invalid-clock' };
  }
  if (session.kind === 'revoked') {
    return { kind: 'denied', reason: 'revoked' };
  }
  if (now >= session.expiresAt) {
    return { kind: 'denied', reason: 'expired' };
  }
  return {
    kind: 'authenticated',
    context: {
      accountId: session.accountId,
      vaultId: session.vaultId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    },
  };
}

export type RotateSessionDecision =
  | {
      readonly kind: 'rotated';
      readonly previous: RevokedSession;
      readonly current: ActiveSession;
      readonly nextToken: SessionToken;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'expired'
        | 'session-id-reused'
        | 'session-token-reused'
        | 'epoch-not-incremented'
        | 'invalid-lifetime';
    };

export function rotateSession(
  session: ActiveSession,
  input: {
    readonly nextSessionId: SessionId;
    readonly nextSessionEpoch: SessionEpoch;
    readonly currentToken: SessionToken;
    readonly nextToken: SessionToken;
    readonly rotatedAt: number;
    readonly expiresAt: number;
  },
): RotateSessionDecision {
  if (input.rotatedAt >= session.expiresAt) {
    return { kind: 'rejected', reason: 'expired' };
  }
  if (input.nextSessionId === session.sessionId) {
    return { kind: 'rejected', reason: 'session-id-reused' };
  }
  if (input.nextToken === input.currentToken) {
    return { kind: 'rejected', reason: 'session-token-reused' };
  }
  if (input.nextSessionEpoch !== session.sessionEpoch + 1) {
    return { kind: 'rejected', reason: 'epoch-not-incremented' };
  }
  if (
    !Number.isSafeInteger(input.rotatedAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.rotatedAt < session.issuedAt ||
    input.expiresAt <= input.rotatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-lifetime' };
  }
  return {
    kind: 'rotated',
    previous: {
      ...session,
      kind: 'revoked',
      revokedAt: input.rotatedAt,
      reason: 'rotated',
    },
    current: {
      kind: 'active',
      sessionId: input.nextSessionId,
      accountId: session.accountId,
      vaultId: session.vaultId,
      sessionEpoch: input.nextSessionEpoch,
      issuedAt: input.rotatedAt,
      expiresAt: input.expiresAt,
    },
    nextToken: input.nextToken,
  };
}

export type RevokeSessionDecision =
  | { readonly kind: 'revoked'; readonly session: RevokedSession }
  | { readonly kind: 'unchanged'; readonly session: RevokedSession }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-revocation-time' };

export function revokeSession(
  session: SessionRecord,
  revokedAt: number,
  reason: Exclude<SessionRevocationReason, 'rotated'>,
): RevokeSessionDecision {
  if (session.kind === 'revoked') {
    return { kind: 'unchanged', session };
  }
  if (!Number.isSafeInteger(revokedAt) || revokedAt < session.issuedAt) {
    return { kind: 'rejected', reason: 'invalid-revocation-time' };
  }
  return {
    kind: 'revoked',
    session: { ...session, kind: 'revoked', revokedAt, reason },
  };
}

export type VaultOperationDecision =
  | { readonly kind: 'authorized' }
  | {
      readonly kind: 'denied';
      readonly reason:
        | 'revoked'
        | 'expired'
        | 'invalid-clock'
        | 'session-mismatch'
        | 'account-mismatch'
        | 'vault-mismatch'
        | 'epoch-mismatch';
    };

export function authorizeVaultOperation(
  context: VaultContext,
  currentSession: SessionRecord,
  now: number,
): VaultOperationDecision {
  const access = authorizeSession(currentSession, now);
  if (access.kind === 'denied') return access;
  if (access.kind === 'anonymous') {
    return { kind: 'denied', reason: 'session-mismatch' };
  }
  if (context.sessionId !== access.context.sessionId) {
    return { kind: 'denied', reason: 'session-mismatch' };
  }
  if (context.accountId !== access.context.accountId) {
    return { kind: 'denied', reason: 'account-mismatch' };
  }
  if (context.vaultId !== access.context.vaultId) {
    return { kind: 'denied', reason: 'vault-mismatch' };
  }
  return context.sessionEpoch === access.context.sessionEpoch
    ? { kind: 'authorized' }
    : { kind: 'denied', reason: 'epoch-mismatch' };
}
