import { describe, expect, it, vi } from 'vitest';
import { createDataEncryptionKey } from '@/server/crypto/key-material';
import type { KeyManagementPort } from '@/server/crypto/ports';
import {
  parseDekRotationOperationId,
  planDekRotationStart,
} from '@/server/crypto/rotation-core';
import type { DekRotationRepository } from '@/server/crypto/rotation-ports';
import { createDekRotationService } from '@/server/crypto/rotation-service';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeDekMetadata,
  envelopeKeyring,
} from '@/tests/fixtures/envelope-crypto';

const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};
const operationId = parseDekRotationOperationId(
  '01991f20-61d2-7000-8000-000000001801',
);

describe('DEK rotation service boundary', () => {
  it('destroys generated raw key material when wrapped metadata is rejected', async () => {
    const operation = generatingOperation();
    const key = createDataEncryptionKey(new Uint8Array(32).fill(0x33));
    const recordGenerated = vi.fn<DekRotationRepository['recordGenerated']>();
    const repository: DekRotationRepository = {
      load: async () => ({
        kind: 'found',
        snapshot: { keyring: envelopeKeyring(), operation },
      }),
      start: vi.fn<DekRotationRepository['start']>(),
      recordGenerated,
      promote: vi.fn<DekRotationRepository['promote']>(),
    };
    const keyManagement: KeyManagementPort = {
      generateDataKey: async () => ({
        metadata: envelopeDekMetadata(2, controlPlaneIds.vaultB),
        key,
      }),
      unwrapDataKey: async () => {
        throw new Error('unexpected unwrap');
      },
    };

    await expect(
      createDekRotationService({ repository, keyManagement }).resume({
        scope,
        operationId,
        performedAt: 2_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'invalid-state' });
    expect(key.destroyed).toBe(true);
    expect(recordGenerated).not.toHaveBeenCalled();
  });
});

function generatingOperation() {
  const plan = planDekRotationStart({
    scope,
    keyring: envelopeKeyring(),
    operationId,
    requestedAt: 1_500,
  });
  if (plan.kind !== 'accepted') throw new Error('rotation start rejected');
  return plan.next;
}
