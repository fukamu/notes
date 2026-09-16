import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError, decodeOrThrow } from '@/lib/codec/core';
import {
  mapVaultQuotaReservationRow,
  mapVaultQuotaSnapshotRow,
  vaultQuotaReservationRowDecoder,
  vaultQuotaSnapshotRowDecoder,
} from '@/server/quota/records';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import { quotaIds } from '@/tests/fixtures/quota';

describe('Vault quota D1 record boundary', () => {
  it('decodes a consistent snapshot and rejects inconsistent derived usage', () => {
    const decoded = decodeOrThrow(
      vaultQuotaSnapshotRowDecoder,
      snapshotRow(),
      'quota snapshot fixture',
    );
    expect(mapVaultQuotaSnapshotRow(decoded)).toMatchObject({
      committed: { activeCards: 2, plaintextBytes: 20 },
      reserved: { activeCards: 1, plaintextBytes: 5 },
      effective: { activeCards: 3, plaintextBytes: 25 },
    });
    const inconsistent = decodeOrThrow(
      vaultQuotaSnapshotRowDecoder,
      { ...snapshotRow(), effective_plaintext_bytes: 24 },
      'inconsistent quota snapshot fixture',
    );
    expect(() => mapVaultQuotaSnapshotRow(inconsistent)).toThrow(
      BoundaryDecodeError,
    );
  });

  it('brands stored UUIDv7 identifiers and rejects malformed values', () => {
    const decoded = decodeOrThrow(
      vaultQuotaReservationRowDecoder,
      reservationRow(),
      'quota reservation fixture',
    );
    expect(mapVaultQuotaReservationRow(decoded)).toMatchObject({
      reservationId: quotaIds.reservationA,
      cardId: quotaIds.cardA,
      state: { kind: 'reserved' },
    });
    expect(
      vaultQuotaReservationRowDecoder.decode({
        ...reservationRow(),
        reservation_id: 'not-a-uuid',
      }).ok,
    ).toBe(false);
  });

  it('rejects contradictory finalized columns and invalid finalized revisions', () => {
    const reserved = decodeOrThrow(
      vaultQuotaReservationRowDecoder,
      { ...reservationRow(), finalized_at: 4_000 },
      'contradictory reservation fixture',
    );
    expect(() => mapVaultQuotaReservationRow(reserved)).toThrow(
      BoundaryDecodeError,
    );

    const finalized = decodeOrThrow(
      vaultQuotaReservationRowDecoder,
      {
        ...reservationRow(),
        state: 'committed',
        finalized_at: 4_000,
        finalized_usage_revision: 1,
      },
      'invalid finalized revision fixture',
    );
    expect(() => mapVaultQuotaReservationRow(finalized)).toThrow(
      BoundaryDecodeError,
    );
  });
});

function snapshotRow() {
  return {
    account_id: controlPlaneIds.accountA,
    vault_id: controlPlaneIds.vaultA,
    revision: 1,
    committed_active_cards: 2,
    committed_plaintext_bytes: 20,
    reserved_active_cards: 1,
    reserved_plaintext_bytes: 5,
    effective_active_cards: 3,
    effective_plaintext_bytes: 25,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

function reservationRow() {
  return {
    account_id: controlPlaneIds.accountA,
    vault_id: controlPlaneIds.vaultA,
    reservation_id: quotaIds.reservationA,
    fingerprint: quotaIds.fingerprintA,
    card_id: quotaIds.cardA,
    change_kind: 'create',
    card_delta: 1,
    plaintext_byte_delta: 100,
    charged_card_delta: 1,
    charged_plaintext_byte_delta: 100,
    usage_revision_at_reservation: 1,
    state: 'reserved',
    created_at: 2_000,
    reconcile_after: 3_000,
    finalized_at: null,
    finalized_usage_revision: null,
  };
}
