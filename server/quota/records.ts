import {
  arrayDecoder,
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { parseCardId, parseMutationId } from '../../lib/domain/id';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import {
  activeCardCountDecoder,
  parseActiveCardCount,
  parseQuotaByteCount,
  quotaByteCountDecoder,
} from './core';
import {
  validVaultQuotaReservation,
  validVaultQuotaSnapshot,
  parseVaultQuotaRevision,
  vaultQuotaFingerprintDecoder,
  vaultQuotaRevisionDecoder,
  type VaultQuotaReservation,
  type VaultQuotaSnapshot,
} from './ledger-core';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const storedIdentifierDecoder = stringDecoder({ minLength: 36, maxLength: 36 });
const signedByteDeltaDecoder = safeIntegerDecoder({
  minimum: -134_217_728,
  maximum: 134_217_728,
});
const cardDeltaDecoder = transformDecoder(
  safeIntegerDecoder({ minimum: -1, maximum: 1 }),
  (value): -1 | 0 | 1 => (value === -1 ? -1 : value === 0 ? 0 : 1),
);
const chargedCardDeltaDecoder = transformDecoder(
  safeIntegerDecoder({ minimum: 0, maximum: 1 }),
  (value): 0 | 1 => (value === 0 ? 0 : 1),
);

export const vaultQuotaSnapshotRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  revision: vaultQuotaRevisionDecoder,
  committed_active_cards: activeCardCountDecoder,
  committed_plaintext_bytes: quotaByteCountDecoder,
  reserved_active_cards: activeCardCountDecoder,
  reserved_plaintext_bytes: quotaByteCountDecoder,
  effective_active_cards: activeCardCountDecoder,
  effective_plaintext_bytes: quotaByteCountDecoder,
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
});

const reservationStateDecoder = unionDecoder(
  literalDecoder('reserved'),
  literalDecoder('committed'),
  literalDecoder('released'),
);

export const vaultQuotaReservationRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  reservation_id: storedIdentifierDecoder,
  fingerprint: vaultQuotaFingerprintDecoder,
  card_id: storedIdentifierDecoder,
  change_kind: unionDecoder(
    literalDecoder('create'),
    literalDecoder('update'),
    literalDecoder('delete'),
  ),
  card_delta: cardDeltaDecoder,
  plaintext_byte_delta: signedByteDeltaDecoder,
  charged_card_delta: chargedCardDeltaDecoder,
  charged_plaintext_byte_delta: quotaByteCountDecoder,
  usage_revision_at_reservation: vaultQuotaRevisionDecoder,
  state: reservationStateDecoder,
  created_at: timestampDecoder,
  reconcile_after: timestampDecoder,
  finalized_at: nullableDecoder(timestampDecoder),
  finalized_usage_revision: nullableDecoder(vaultQuotaRevisionDecoder),
});

export const vaultQuotaReservationRowsDecoder = objectDecoder(
  {
    results: arrayDecoder(vaultQuotaReservationRowDecoder, {
      maxLength: 100,
      uniqueBy: (row) => row.reservation_id,
    }),
  },
  { unknownFields: 'allow' },
);

export type VaultQuotaSnapshotRow = InferDecoder<
  typeof vaultQuotaSnapshotRowDecoder
>;
export type VaultQuotaReservationRow = InferDecoder<
  typeof vaultQuotaReservationRowDecoder
>;

export function mapVaultQuotaSnapshotRow(
  row: VaultQuotaSnapshotRow,
): VaultQuotaSnapshot {
  const snapshot: VaultQuotaSnapshot = {
    accountId: row.account_id,
    vaultId: row.vault_id,
    revision: row.revision,
    committed: {
      activeCards: row.committed_active_cards,
      plaintextBytes: row.committed_plaintext_bytes,
    },
    reserved: {
      activeCards: row.reserved_active_cards,
      plaintextBytes: row.reserved_plaintext_bytes,
    },
    effective: {
      activeCards: row.effective_active_cards,
      plaintextBytes: row.effective_plaintext_bytes,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!validVaultQuotaSnapshot(snapshot)) return invalidQuotaRow('snapshot');
  return snapshot;
}

export function mapVaultQuotaReservationRow(
  row: VaultQuotaReservationRow,
): VaultQuotaReservation {
  const state = reservationState(row);
  const reservation: VaultQuotaReservation = {
    accountId: row.account_id,
    vaultId: row.vault_id,
    reservationId: parseMutationId(row.reservation_id),
    fingerprint: row.fingerprint,
    cardId: parseCardId(row.card_id),
    changeKind: row.change_kind,
    cardDelta: row.card_delta,
    plaintextByteDelta: row.plaintext_byte_delta,
    chargedCardDelta: row.charged_card_delta,
    chargedPlaintextByteDelta: row.charged_plaintext_byte_delta,
    usageRevisionAtReservation: row.usage_revision_at_reservation,
    state,
    createdAt: row.created_at,
    reconcileAfter: row.reconcile_after,
  };
  if (!validVaultQuotaReservation(reservation)) {
    return invalidQuotaRow('reservation');
  }
  return reservation;
}

function reservationState(row: VaultQuotaReservationRow) {
  if (row.state === 'reserved') {
    if (row.finalized_at !== null || row.finalized_usage_revision !== null) {
      return invalidQuotaRow('reservation state');
    }
    return { kind: 'reserved' } as const;
  }
  if (row.finalized_at === null || row.finalized_usage_revision === null) {
    return invalidQuotaRow('reservation state');
  }
  return {
    kind: row.state,
    finalizedAt: row.finalized_at,
    usageRevision: row.finalized_usage_revision,
  } as const;
}

export function emptyVaultQuotaSnapshot(input: {
  readonly accountId: VaultQuotaSnapshot['accountId'];
  readonly vaultId: VaultQuotaSnapshot['vaultId'];
  readonly initializedAt: number;
}): VaultQuotaSnapshot {
  return {
    accountId: input.accountId,
    vaultId: input.vaultId,
    revision: parseVaultQuotaRevision(1),
    committed: {
      activeCards: parseActiveCardCount(0),
      plaintextBytes: parseQuotaByteCount(0),
    },
    reserved: {
      activeCards: parseActiveCardCount(0),
      plaintextBytes: parseQuotaByteCount(0),
    },
    effective: {
      activeCards: parseActiveCardCount(0),
      plaintextBytes: parseQuotaByteCount(0),
    },
    createdAt: input.initializedAt,
    updatedAt: input.initializedAt,
  };
}

function invalidQuotaRow(detail: string): never {
  throw new BoundaryDecodeError('D1 Vault quota row', [
    { path: [], reason: `inconsistent ${detail}` },
  ]);
}
