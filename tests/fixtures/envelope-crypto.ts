import { decodeOrThrow } from '@/lib/codec/core';
import type { VaultId } from '@/lib/domain/identity';
import {
  decodeVaultDekKeyring,
  parseCryptoObjectRevision,
  parseDekVersion,
  vaultDekMetadataDecoder,
  type EnvelopeObjectContext,
  type VaultDekMetadata,
} from '@/server/crypto/core';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';

export const envelopeCryptoIds = {
  cardA: fixtureCardId('envelope-card-a'),
  cardB: fixtureCardId('envelope-card-b'),
  conflict: fixtureConflictId('envelope-conflict'),
  dekVersion1: parseDekVersion(1),
  dekVersion2: parseDekVersion(2),
  dekVersion3: parseDekVersion(3),
  objectRevision1: parseCryptoObjectRevision(1),
  objectRevision2: parseCryptoObjectRevision(2),
  nonceA: 'AAAAAAAAAAAAAAAA',
  nonceB: 'AQEBAQEBAQEBAQEB',
} as const;

export const envelopeKeyBytes = {
  version1: new Uint8Array(32).fill(0x11),
  version2: new Uint8Array(32).fill(0x22),
} as const;

export function envelopeDekMetadata(
  version: 1 | 2,
  vaultId: VaultId = controlPlaneIds.vaultA,
): VaultDekMetadata {
  return decodeOrThrow(
    vaultDekMetadataDecoder,
    {
      vaultId,
      dekVersion:
        version === 1
          ? envelopeCryptoIds.dekVersion1
          : envelopeCryptoIds.dekVersion2,
      kekKeyReference: `fake-kek-version-${version}`,
      wrappedDek:
        version === 1
          ? 'ZmFrZS13cmFwcGVkLWRlay12MQ'
          : 'ZmFrZS13cmFwcGVkLWRlay12Mg',
      createdAt: version * 1_000,
    },
    'envelope DEK fixture',
  );
}

export function envelopeKeyring(version: 1 | 2 = 1) {
  const first = envelopeDekMetadata(1);
  return decodeVaultDekKeyring({
    vaultId: controlPlaneIds.vaultA,
    writeVersion:
      version === 1
        ? envelopeCryptoIds.dekVersion1
        : envelopeCryptoIds.dekVersion2,
    versions: version === 1 ? [first] : [first, envelopeDekMetadata(2)],
  });
}

export function envelopeObjectContext(
  input: {
    readonly vaultId?: VaultId;
    readonly card?: 'a' | 'b';
    readonly revision?: 1 | 2;
  } = {},
): EnvelopeObjectContext {
  return {
    vaultId: input.vaultId ?? controlPlaneIds.vaultA,
    object: {
      kind: 'card',
      objectId:
        input.card === 'b' ? envelopeCryptoIds.cardB : envelopeCryptoIds.cardA,
    },
    objectRevision:
      input.revision === 2
        ? envelopeCryptoIds.objectRevision2
        : envelopeCryptoIds.objectRevision1,
  };
}
