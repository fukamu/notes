import { describe, expect, it } from 'vitest';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyring,
} from '@/tests/fixtures/envelope-crypto';
import {
  dekRotationOperationDecoder,
  parseDekRotationOperationId,
  planDekRotationGenerated,
  planDekRotationPromotion,
  planDekRotationStart,
  sameDekRotationOperation,
  validDekRotationSnapshot,
} from '@/server/crypto/rotation-core';

const operationA = parseDekRotationOperationId(
  '01991f20-61d2-7000-8000-000000001801',
);
const operationB = parseDekRotationOperationId(
  '01991f20-61d2-7000-8000-000000001802',
);
const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};

describe('DEK rotation pure lifecycle', () => {
  it('checkpoints generation and promotion while preserving mixed versions', () => {
    const start = planDekRotationStart({
      scope,
      keyring: envelopeKeyring(),
      operationId: operationA,
      requestedAt: 1_500,
    });
    expect(start).toMatchObject({
      kind: 'accepted',
      next: {
        revision: 1,
        sourceVersion: envelopeCryptoIds.dekVersion1,
        targetVersion: envelopeCryptoIds.dekVersion2,
        state: { kind: 'generating' },
      },
    });
    if (start.kind !== 'accepted') throw new Error('rotation start rejected');

    const generated = planDekRotationGenerated({
      operation: start.next,
      metadata: envelopeDekMetadata(2),
      generatedAt: 2_000,
    });
    expect(generated).toMatchObject({
      kind: 'accepted',
      transition: { next: { revision: 2, state: { kind: 'promoting' } } },
    });
    if (generated.kind !== 'accepted') {
      throw new Error('generated key rejected');
    }

    const promotion = planDekRotationPromotion({
      operation: generated.transition.next,
      keyring: envelopeKeyring(),
      completedAt: 2_100,
    });
    expect(promotion).toMatchObject({
      kind: 'accepted',
      transition: {
        next: {
          revision: 3,
          state: { kind: 'completed', completedAt: 2_100 },
        },
      },
    });
    if (promotion.kind !== 'accepted') {
      throw new Error('promotion rejected');
    }
    expect(
      validDekRotationSnapshot({
        keyring: envelopeKeyring(2),
        operation: promotion.transition.next,
      }),
    ).toBe(true);
  });

  it('replays one operation, rejects concurrent starts, and permits the next rotation only after completion', () => {
    const start = acceptedStart();
    expect(
      planDekRotationStart({
        scope,
        keyring: envelopeKeyring(),
        current: start,
        operationId: operationA,
        requestedAt: 1_600,
      }),
    ).toEqual({ kind: 'replayed', operation: start });
    expect(
      planDekRotationStart({
        scope,
        keyring: envelopeKeyring(),
        current: start,
        operationId: operationB,
        requestedAt: 1_600,
      }),
    ).toEqual({ kind: 'rejected', reason: 'active-rotation' });

    const completed = completedOperation();
    const next = planDekRotationStart({
      scope,
      keyring: envelopeKeyring(2),
      current: completed,
      operationId: operationB,
      requestedAt: 2_200,
    });
    expect(next).toMatchObject({
      kind: 'accepted',
      current: completed,
      next: {
        sourceVersion: envelopeCryptoIds.dekVersion2,
        targetVersion: envelopeCryptoIds.dekVersion3,
      },
    });
  });

  it('rejects wrong Vault, malformed metadata, stale time, and inconsistent snapshots', () => {
    expect(
      planDekRotationStart({
        scope: { ...scope, vaultId: controlPlaneIds.vaultB },
        keyring: envelopeKeyring(),
        operationId: operationA,
        requestedAt: 1_500,
      }),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
    const start = acceptedStart();
    expect(
      planDekRotationGenerated({
        operation: start,
        metadata: envelopeDekMetadata(2, controlPlaneIds.vaultB),
        generatedAt: 2_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-metadata' });
    expect(
      planDekRotationGenerated({
        operation: start,
        metadata: envelopeDekMetadata(2),
        generatedAt: 1_400,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
    expect(
      validDekRotationSnapshot({
        keyring: envelopeKeyring(2),
        operation: start,
      }),
    ).toBe(false);
    expect(
      planDekRotationStart({
        scope: { ...scope, accountId: controlPlaneIds.accountB },
        keyring: envelopeKeyring(),
        current: start,
        operationId: operationA,
        requestedAt: 1_600,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
  });

  it('decodes only UUIDv7 operations with consistent phase data', () => {
    const operation = completedOperation();
    expect(dekRotationOperationDecoder.decode(operation)).toEqual({
      ok: true,
      value: operation,
    });
    expect(
      dekRotationOperationDecoder.decode({
        ...operation,
        operationId: 'not-a-rotation-id',
      }).ok,
    ).toBe(false);
    expect(
      dekRotationOperationDecoder.decode({
        ...operation,
        targetVersion: envelopeCryptoIds.dekVersion1,
      }).ok,
    ).toBe(false);
    expect(() => parseDekRotationOperationId('not-a-uuid')).toThrow();
    expect(sameDekRotationOperation(operation, { ...operation })).toBe(true);
  });
});

function acceptedStart() {
  const start = planDekRotationStart({
    scope,
    keyring: envelopeKeyring(),
    operationId: operationA,
    requestedAt: 1_500,
  });
  if (start.kind !== 'accepted') throw new Error('rotation start rejected');
  return start.next;
}

function completedOperation() {
  const generated = planDekRotationGenerated({
    operation: acceptedStart(),
    metadata: envelopeDekMetadata(2),
    generatedAt: 2_000,
  });
  if (generated.kind !== 'accepted') {
    throw new Error('generated key rejected');
  }
  const promotion = planDekRotationPromotion({
    operation: generated.transition.next,
    keyring: envelopeKeyring(),
    completedAt: 2_100,
  });
  if (promotion.kind !== 'accepted') throw new Error('promotion rejected');
  return promotion.transition.next;
}
