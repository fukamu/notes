import {
  decodeOrThrow,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { CardId, MutationId } from '../../lib/domain/id';
import type { AccountId, VaultId } from '../../lib/domain/identity';
import type { PersonalVaultLimits } from '../entitlement/public';
import {
  evaluateVaultQuotaChange,
  parseActiveCardCount,
  parseQuotaByteCount,
  type QuotaByteCount,
  type VaultQuotaChange,
  type VaultQuotaUsage,
} from './core';

declare const quotaFingerprintBrand: unique symbol;
declare const quotaRevisionBrand: unique symbol;

export type VaultQuotaScope = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
};

export type VaultQuotaFingerprint = string & {
  readonly [quotaFingerprintBrand]: 'VaultQuotaFingerprint';
};
export type VaultQuotaRevision = number & {
  readonly [quotaRevisionBrand]: 'VaultQuotaRevision';
};

export const vaultQuotaFingerprintDecoder: Decoder<VaultQuotaFingerprint> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 43, maxLength: 43 }),
      (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
      'expected an unpadded SHA-256 base64url digest',
    ),
    // The digest shape above is the runtime proof for this nominal type.
    (value) => value as VaultQuotaFingerprint,
  );
export const vaultQuotaRevisionDecoder: Decoder<VaultQuotaRevision> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    // The safe positive integer decoder is the runtime proof for this brand.
    (value) => value as VaultQuotaRevision,
  );

export function parseVaultQuotaFingerprint(
  input: unknown,
): VaultQuotaFingerprint {
  return decodeOrThrow(
    vaultQuotaFingerprintDecoder,
    input,
    'Vault quota fingerprint',
  );
}

export function parseVaultQuotaRevision(input: unknown): VaultQuotaRevision {
  return decodeOrThrow(
    vaultQuotaRevisionDecoder,
    input,
    'Vault quota revision',
  );
}

export type VaultQuotaSnapshot = VaultQuotaScope & {
  readonly revision: VaultQuotaRevision;
  readonly committed: VaultQuotaUsage;
  readonly reserved: VaultQuotaUsage;
  readonly effective: VaultQuotaUsage;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type VaultQuotaReservationState =
  | { readonly kind: 'reserved' }
  | {
      readonly kind: 'committed';
      readonly finalizedAt: number;
      readonly usageRevision: VaultQuotaRevision;
    }
  | {
      readonly kind: 'released';
      readonly finalizedAt: number;
      readonly usageRevision: VaultQuotaRevision;
    };

export type VaultQuotaReservation = VaultQuotaScope & {
  readonly reservationId: MutationId;
  readonly fingerprint: VaultQuotaFingerprint;
  readonly cardId: CardId;
  readonly changeKind: VaultQuotaChange['kind'];
  readonly cardDelta: -1 | 0 | 1;
  readonly plaintextByteDelta: number;
  readonly chargedCardDelta: 0 | 1;
  readonly chargedPlaintextByteDelta: QuotaByteCount;
  readonly usageRevisionAtReservation: VaultQuotaRevision;
  readonly state: VaultQuotaReservationState;
  readonly createdAt: number;
  readonly reconcileAfter: number;
};

export type VaultQuotaReservationCommand = {
  readonly reservationId: MutationId;
  readonly fingerprint: VaultQuotaFingerprint;
  readonly cardId: CardId;
  readonly change: VaultQuotaChange;
  readonly limits: PersonalVaultLimits;
  readonly requestedAt: number;
  readonly reconcileAfter: number;
};

export type VaultQuotaReservationPlan =
  | {
      readonly kind: 'apply';
      readonly current: VaultQuotaSnapshot;
      readonly reservation: VaultQuotaReservation;
    }
  | {
      readonly kind: 'replay';
      readonly reservation: VaultQuotaReservation;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-input'
        | 'idempotency-key-reuse'
        | 'active-card-limit'
        | 'vault-plaintext-limit';
    };

export type VaultQuotaFinalizationCommand = {
  readonly reservationId: MutationId;
  readonly fingerprint: VaultQuotaFingerprint;
  readonly outcome: 'commit' | 'release';
  readonly limits: PersonalVaultLimits;
  readonly finalizedAt: number;
};

export type VaultQuotaFinalizationPlan =
  | {
      readonly kind: 'apply';
      readonly current: VaultQuotaSnapshot;
      readonly next: VaultQuotaSnapshot;
      readonly reservation: VaultQuotaReservation;
    }
  | {
      readonly kind: 'replay';
      readonly reservation: VaultQuotaReservation;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-input'
        | 'idempotency-key-reuse'
        | 'invalid-state';
    };

export function planVaultQuotaReservation(input: {
  readonly scope: VaultQuotaScope;
  readonly current: VaultQuotaSnapshot;
  readonly existing: VaultQuotaReservation | undefined;
  readonly command: VaultQuotaReservationCommand;
}): VaultQuotaReservationPlan {
  if (
    !validSnapshot(input.current) ||
    !sameScope(input.scope, input.current) ||
    !validTimestamp(input.command.requestedAt) ||
    !validTimestamp(input.command.reconcileAfter) ||
    input.command.reconcileAfter <= input.command.requestedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-input' };
  }
  if (input.existing !== undefined) {
    if (
      !sameScope(input.scope, input.existing) ||
      !validReservation(input.existing) ||
      input.existing.reservationId !== input.command.reservationId
    ) {
      return { kind: 'rejected', reason: 'invalid-input' };
    }
    return input.existing.fingerprint === input.command.fingerprint
      ? { kind: 'replay', reservation: input.existing }
      : { kind: 'rejected', reason: 'idempotency-key-reuse' };
  }
  const evaluated = evaluateVaultQuotaChange({
    current: input.current.effective,
    change: input.command.change,
    limits: input.command.limits,
  });
  if (evaluated.kind === 'rejected') {
    return {
      kind: 'rejected',
      reason:
        evaluated.reason === 'invalid-usage'
          ? 'invalid-input'
          : evaluated.reason,
    };
  }
  const chargedCardDelta = evaluated.cardDelta > 0 ? 1 : 0;
  const chargedPlaintextByteDelta = parseQuotaByteCount(
    Math.max(0, evaluated.plaintextByteDelta),
  );
  const reservation: VaultQuotaReservation = {
    ...input.scope,
    reservationId: input.command.reservationId,
    fingerprint: input.command.fingerprint,
    cardId: input.command.cardId,
    changeKind: input.command.change.kind,
    cardDelta: evaluated.cardDelta,
    plaintextByteDelta: evaluated.plaintextByteDelta,
    chargedCardDelta,
    chargedPlaintextByteDelta,
    usageRevisionAtReservation: input.current.revision,
    state: { kind: 'reserved' },
    createdAt: input.command.requestedAt,
    reconcileAfter: input.command.reconcileAfter,
  };
  return validReservation(reservation)
    ? { kind: 'apply', current: input.current, reservation }
    : { kind: 'rejected', reason: 'invalid-input' };
}

export function planVaultQuotaFinalization(input: {
  readonly scope: VaultQuotaScope;
  readonly current: VaultQuotaSnapshot;
  readonly reservation: VaultQuotaReservation;
  readonly command: VaultQuotaFinalizationCommand;
}): VaultQuotaFinalizationPlan {
  if (
    !sameScope(input.scope, input.current) ||
    !sameScope(input.scope, input.reservation) ||
    input.reservation.reservationId !== input.command.reservationId ||
    !validSnapshot(input.current) ||
    !validReservation(input.reservation) ||
    !validTimestamp(input.command.finalizedAt) ||
    input.command.finalizedAt < input.reservation.createdAt
  ) {
    return { kind: 'rejected', reason: 'invalid-input' };
  }
  if (input.reservation.fingerprint !== input.command.fingerprint) {
    return { kind: 'rejected', reason: 'idempotency-key-reuse' };
  }
  if (input.reservation.state.kind !== 'reserved') {
    const expectedState =
      input.command.outcome === 'commit' ? 'committed' : 'released';
    return input.reservation.state.kind === expectedState
      ? { kind: 'replay', reservation: input.reservation }
      : { kind: 'rejected', reason: 'invalid-state' };
  }
  const committedDelta =
    input.command.outcome === 'commit'
      ? {
          cards: input.reservation.cardDelta,
          bytes: input.reservation.plaintextByteDelta,
        }
      : { cards: 0, bytes: 0 };
  const nextRevision = nextQuotaRevision(input.current.revision);
  if (nextRevision === undefined) {
    return { kind: 'rejected', reason: 'invalid-input' };
  }
  const committed = addUsage(input.current.committed, committedDelta);
  const reserved = addUsage(input.current.reserved, {
    cards: 0 - input.reservation.chargedCardDelta,
    bytes: 0 - input.reservation.chargedPlaintextByteDelta,
  });
  if (committed === undefined || reserved === undefined) {
    return { kind: 'rejected', reason: 'invalid-input' };
  }
  const effective = addUsage(committed, {
    cards: reserved.activeCards,
    bytes: reserved.plaintextBytes,
  });
  if (
    effective === undefined ||
    effective.activeCards > input.command.limits.activeCards ||
    effective.plaintextBytes > input.command.limits.plaintextBytesPerVault
  ) {
    return { kind: 'rejected', reason: 'invalid-input' };
  }
  const state = {
    kind: input.command.outcome === 'commit' ? 'committed' : 'released',
    finalizedAt: input.command.finalizedAt,
    usageRevision: nextRevision,
  } as const;
  return {
    kind: 'apply',
    current: input.current,
    next: {
      ...input.scope,
      revision: nextRevision,
      committed,
      reserved,
      effective,
      createdAt: input.current.createdAt,
      updatedAt: input.command.finalizedAt,
    },
    reservation: { ...input.reservation, state },
  };
}

export function validVaultQuotaSnapshot(snapshot: VaultQuotaSnapshot): boolean {
  return validSnapshot(snapshot);
}

export function validVaultQuotaReservation(
  reservation: VaultQuotaReservation,
): boolean {
  return validReservation(reservation);
}

function validSnapshot(snapshot: VaultQuotaSnapshot): boolean {
  const effective = addUsage(snapshot.committed, {
    cards: snapshot.reserved.activeCards,
    bytes: snapshot.reserved.plaintextBytes,
  });
  return (
    effective !== undefined &&
    effective.activeCards === snapshot.effective.activeCards &&
    effective.plaintextBytes === snapshot.effective.plaintextBytes &&
    validTimestamp(snapshot.createdAt) &&
    validTimestamp(snapshot.updatedAt) &&
    snapshot.createdAt <= snapshot.updatedAt
  );
}

function validReservation(reservation: VaultQuotaReservation): boolean {
  const validChange =
    (reservation.changeKind === 'create' &&
      reservation.cardDelta === 1 &&
      reservation.plaintextByteDelta >= 0 &&
      reservation.chargedCardDelta === 1 &&
      reservation.chargedPlaintextByteDelta ===
        reservation.plaintextByteDelta) ||
    (reservation.changeKind === 'update' &&
      reservation.cardDelta === 0 &&
      reservation.chargedCardDelta === 0 &&
      reservation.chargedPlaintextByteDelta ===
        Math.max(0, reservation.plaintextByteDelta)) ||
    (reservation.changeKind === 'delete' &&
      reservation.cardDelta === -1 &&
      reservation.plaintextByteDelta <= 0 &&
      reservation.chargedCardDelta === 0 &&
      reservation.chargedPlaintextByteDelta === 0);
  if (
    !validChange ||
    !Number.isSafeInteger(reservation.plaintextByteDelta) ||
    !validTimestamp(reservation.createdAt) ||
    !validTimestamp(reservation.reconcileAfter) ||
    reservation.reconcileAfter <= reservation.createdAt
  ) {
    return false;
  }
  return (
    reservation.state.kind === 'reserved' ||
    (validTimestamp(reservation.state.finalizedAt) &&
      reservation.state.finalizedAt >= reservation.createdAt &&
      reservation.state.usageRevision > reservation.usageRevisionAtReservation)
  );
}

function addUsage(
  usage: VaultQuotaUsage,
  delta: { readonly cards: number; readonly bytes: number },
): VaultQuotaUsage | undefined {
  const cards = usage.activeCards + delta.cards;
  const bytes = usage.plaintextBytes + delta.bytes;
  if (
    !Number.isSafeInteger(cards) ||
    !Number.isSafeInteger(bytes) ||
    cards < 0 ||
    bytes < 0
  ) {
    return undefined;
  }
  return {
    activeCards: parseActiveCardCount(cards),
    plaintextBytes: parseQuotaByteCount(bytes),
  };
}

function nextQuotaRevision(
  current: VaultQuotaRevision,
): VaultQuotaRevision | undefined {
  const next = current + 1;
  try {
    return parseVaultQuotaRevision(next);
  } catch {
    return undefined;
  }
}

function sameScope(
  expected: VaultQuotaScope,
  candidate: VaultQuotaScope,
): boolean {
  return (
    expected.accountId === candidate.accountId &&
    expected.vaultId === candidate.vaultId
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
