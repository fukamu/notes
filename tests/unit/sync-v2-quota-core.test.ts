import { describe, expect, it } from 'vitest';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import {
  parseDisplayCharacterCount,
  parseQuotaByteCount,
  quotaTransportLimits,
} from '@/server/quota/public';
import {
  canonicalizeSyncV2CardDeletion,
  evaluateSyncV2QuotaMeasurement,
  syncV2QuotaReconcileAfter,
  toSyncV2VaultQuotaChange,
} from '@/server/sync-v2/quota-core';
import { quotaIds } from '@/tests/fixtures/quota';

describe('Sync v2 quota pure coordination', () => {
  it('maps create, update, conflict, and delete to exact Vault deltas', () => {
    expect(
      toSyncV2VaultQuotaChange({
        kind: 'card-write',
        currentPlaintextBytes: null,
        nextPlaintextBytes: bytes(10),
      }),
    ).toEqual({ kind: 'create', nextPlaintextBytes: 10 });
    expect(
      toSyncV2VaultQuotaChange({
        kind: 'card-write',
        currentPlaintextBytes: bytes(10),
        nextPlaintextBytes: bytes(8),
      }),
    ).toEqual({
      kind: 'update',
      currentPlaintextBytes: 10,
      nextPlaintextBytes: 8,
    });
    expect(
      toSyncV2VaultQuotaChange({
        kind: 'conflict-write',
        currentCardPlaintextBytes: bytes(10),
      }),
    ).toEqual({
      kind: 'update',
      currentPlaintextBytes: 10,
      nextPlaintextBytes: 10,
    });
    expect(
      toSyncV2VaultQuotaChange({
        kind: 'card-delete',
        currentPlaintextBytes: bytes(10),
      }),
    ).toEqual({ kind: 'delete', currentPlaintextBytes: 10 });
  });

  it('keeps request, display, and serialized plaintext denials distinct', () => {
    const base = {
      displayCharacters: parseDisplayCharacterCount(1_000),
      serializedPlaintextBytes: bytes(8_192),
      requestBytes: bytes(4_000_000),
    };
    expect(evaluate(base)).toEqual({ kind: 'accepted' });
    expect(
      evaluate({
        ...base,
        displayCharacters: parseDisplayCharacterCount(1_001),
      }),
    ).toEqual({ kind: 'rejected', reason: 'display-character-limit' });
    expect(
      evaluate({ ...base, serializedPlaintextBytes: bytes(8_193) }),
    ).toEqual({ kind: 'rejected', reason: 'serialized-plaintext-limit' });
    expect(evaluate({ ...base, requestBytes: bytes(4_000_001) })).toEqual({
      kind: 'rejected',
      reason: 'request-limit',
    });
  });

  it('validates reconciliation arithmetic and canonical deletion identity', () => {
    expect(syncV2QuotaReconcileAfter(1_000, 60_000)).toBe(61_000);
    expect(syncV2QuotaReconcileAfter(1_000, 0)).toBeUndefined();
    expect(
      syncV2QuotaReconcileAfter(Number.MAX_SAFE_INTEGER, 1),
    ).toBeUndefined();
    expect(
      canonicalizeSyncV2CardDeletion({
        mutationId: quotaIds.reservationA,
        cardId: quotaIds.cardA,
        expectedRevision: 2,
        deletedAt: 3_000,
      }),
    ).toContain('fukamu-sync-v2-card-delete/v1');
  });
});

function evaluate(
  measurement: Parameters<
    typeof evaluateSyncV2QuotaMeasurement
  >[0]['measurement'],
) {
  return evaluateSyncV2QuotaMeasurement({
    measurement,
    limits: paidPersonalVaultLimits,
    transportLimits: quotaTransportLimits,
  });
}

function bytes(value: number) {
  return parseQuotaByteCount(value);
}
