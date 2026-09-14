import { describe, expect, it } from 'vitest';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import {
  parseActiveCardCount,
  parseQuotaByteCount,
  parseVaultQuotaRevision,
  planVaultQuotaFinalization,
  planVaultQuotaReservation,
  type VaultQuotaReservation,
  type VaultQuotaReservationCommand,
  type VaultQuotaSnapshot,
} from '@/server/quota/public';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import { quotaIds } from '@/tests/fixtures/quota';

const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};

describe('Vault quota ledger pure core', () => {
  it('reserves the 10,000th card and rejects the 10,001st', () => {
    const accepted = reserve(snapshot(9_999, 1_000), createCommand());
    expect(accepted).toMatchObject({
      kind: 'apply',
      reservation: {
        changeKind: 'create',
        cardDelta: 1,
        plaintextByteDelta: 8_192,
        chargedCardDelta: 1,
        chargedPlaintextByteDelta: 8_192,
        state: { kind: 'reserved' },
      },
    });
    expect(reserve(snapshot(10_000, 1_000), createCommand())).toEqual({
      kind: 'rejected',
      reason: 'active-card-limit',
    });
  });

  it('does not free capacity for a decrease or delete before commit', () => {
    const update = reserve(snapshot(2, 20), {
      ...createCommand(),
      change: {
        kind: 'update',
        currentPlaintextBytes: bytes(10),
        nextPlaintextBytes: bytes(4),
      },
    });
    if (update.kind !== 'apply') throw new Error('update was rejected');
    expect(update.reservation).toMatchObject({
      cardDelta: 0,
      plaintextByteDelta: -6,
      chargedCardDelta: 0,
      chargedPlaintextByteDelta: 0,
    });
    const updated = finalize(snapshot(2, 20), update.reservation, 'commit');
    expect(updated).toMatchObject({
      kind: 'apply',
      next: {
        committed: { activeCards: 2, plaintextBytes: 14 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
        effective: { activeCards: 2, plaintextBytes: 14 },
      },
    });

    const deletion = reserve(snapshot(2, 20), {
      ...createCommand(),
      change: { kind: 'delete', currentPlaintextBytes: bytes(8) },
    });
    if (deletion.kind !== 'apply') throw new Error('delete was rejected');
    expect(deletion.reservation).toMatchObject({
      cardDelta: -1,
      plaintextByteDelta: -8,
      chargedCardDelta: 0,
      chargedPlaintextByteDelta: 0,
    });
    expect(
      finalize(snapshot(2, 20), deletion.reservation, 'commit'),
    ).toMatchObject({
      kind: 'apply',
      next: {
        committed: { activeCards: 1, plaintextBytes: 12 },
        effective: { activeCards: 1, plaintextBytes: 12 },
      },
    });
  });

  it('moves a positive reservation into committed usage or releases it exactly once', () => {
    const planned = reserve(snapshot(9_999, 1_000), createCommand());
    if (planned.kind !== 'apply') throw new Error('create was rejected');
    const withReservation = snapshot(9_999, 1_000, 1, 8_192);
    const committed = finalize(withReservation, planned.reservation, 'commit');
    expect(committed).toMatchObject({
      kind: 'apply',
      next: {
        revision: 2,
        committed: { activeCards: 10_000, plaintextBytes: 9_192 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
        effective: { activeCards: 10_000, plaintextBytes: 9_192 },
      },
      reservation: {
        state: { kind: 'committed', finalizedAt: 3_000, usageRevision: 2 },
      },
    });
    const released = finalize(withReservation, planned.reservation, 'release');
    expect(released).toMatchObject({
      kind: 'apply',
      next: {
        committed: { activeCards: 9_999, plaintextBytes: 1_000 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
        effective: { activeCards: 9_999, plaintextBytes: 1_000 },
      },
      reservation: { state: { kind: 'released' } },
    });
  });

  it('replays only the same fingerprint and never reverses a finalized outcome', () => {
    const planned = reserve(snapshot(0, 0), createCommand());
    if (planned.kind !== 'apply') throw new Error('create was rejected');
    expect(
      planVaultQuotaReservation({
        scope,
        current: snapshot(0, 0),
        existing: planned.reservation,
        command: createCommand(),
      }),
    ).toEqual({ kind: 'replay', reservation: planned.reservation });
    expect(
      planVaultQuotaReservation({
        scope,
        current: snapshot(0, 0),
        existing: planned.reservation,
        command: { ...createCommand(), fingerprint: quotaIds.fingerprintB },
      }),
    ).toEqual({ kind: 'rejected', reason: 'idempotency-key-reuse' });

    const committed = finalize(
      snapshot(0, 0, 1, 8_192),
      planned.reservation,
      'commit',
    );
    if (committed.kind !== 'apply') throw new Error('commit was rejected');
    expect(finalize(committed.next, committed.reservation, 'commit')).toEqual({
      kind: 'replay',
      reservation: committed.reservation,
    });
    expect(finalize(committed.next, committed.reservation, 'release')).toEqual({
      kind: 'rejected',
      reason: 'invalid-state',
    });
  });

  it('rejects inconsistent snapshots, timestamps, scopes, and fingerprints', () => {
    expect(
      reserve(
        {
          ...snapshot(1, 1),
          effective: usage(2, 1),
        },
        createCommand(),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' });
    expect(
      reserve(snapshot(0, 0), {
        ...createCommand(),
        reconcileAfter: 2_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' });
    const planned = reserve(snapshot(0, 0), createCommand());
    if (planned.kind !== 'apply') throw new Error('create was rejected');
    expect(
      planVaultQuotaFinalization({
        scope,
        current: snapshot(0, 0, 1, 8_192),
        reservation: planned.reservation,
        command: {
          reservationId: quotaIds.reservationA,
          fingerprint: quotaIds.fingerprintB,
          outcome: 'commit',
          limits: paidPersonalVaultLimits,
          finalizedAt: 3_000,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'idempotency-key-reuse' });
    expect(
      planVaultQuotaFinalization({
        scope,
        current: snapshot(0, 0, 1, 8_192),
        reservation: planned.reservation,
        command: {
          reservationId: quotaIds.reservationB,
          fingerprint: quotaIds.fingerprintA,
          outcome: 'commit',
          limits: paidPersonalVaultLimits,
          finalizedAt: 3_000,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' });
  });
});

function createCommand(): VaultQuotaReservationCommand {
  return {
    reservationId: quotaIds.reservationA,
    fingerprint: quotaIds.fingerprintA,
    cardId: quotaIds.cardA,
    change: { kind: 'create', nextPlaintextBytes: bytes(8_192) },
    limits: paidPersonalVaultLimits,
    requestedAt: 2_000,
    reconcileAfter: 3_000,
  };
}

function reserve(
  current: VaultQuotaSnapshot,
  command: VaultQuotaReservationCommand,
) {
  return planVaultQuotaReservation({
    scope,
    current,
    existing: undefined,
    command,
  });
}

function finalize(
  current: VaultQuotaSnapshot,
  reservation: VaultQuotaReservation,
  outcome: 'commit' | 'release',
) {
  return planVaultQuotaFinalization({
    scope,
    current,
    reservation,
    command: {
      reservationId: reservation.reservationId,
      fingerprint: reservation.fingerprint,
      outcome,
      limits: paidPersonalVaultLimits,
      finalizedAt: 3_000,
    },
  });
}

function snapshot(
  committedCards: number,
  committedBytes: number,
  reservedCards = 0,
  reservedBytes = 0,
): VaultQuotaSnapshot {
  return {
    ...scope,
    revision: parseVaultQuotaRevision(1),
    committed: usage(committedCards, committedBytes),
    reserved: usage(reservedCards, reservedBytes),
    effective: usage(
      committedCards + reservedCards,
      committedBytes + reservedBytes,
    ),
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function usage(activeCards: number, plaintextBytes: number) {
  return {
    activeCards: parseActiveCardCount(activeCards),
    plaintextBytes: bytes(plaintextBytes),
  };
}

function bytes(value: number) {
  return parseQuotaByteCount(value);
}
