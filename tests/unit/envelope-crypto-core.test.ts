import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_CRYPTO_VERSION,
  decodeEnvelopeCiphertext,
  planDekRotation,
  selectDekForRead,
  selectDekForWrite,
  serializeEnvelopeAad,
} from '@/server/crypto/core';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyring,
  envelopeObjectContext,
} from '@/tests/fixtures/envelope-crypto';

describe('Envelope encryption pure contract', () => {
  it('binds Vault, object type/id, revision, crypto version, and DEK version into AAD', () => {
    const aad = serializeEnvelopeAad({
      context: envelopeObjectContext(),
      dekVersion: envelopeCryptoIds.dekVersion1,
    });
    for (const value of [
      controlPlaneIds.vaultA,
      envelopeCryptoIds.cardA,
      'card',
      ENVELOPE_CRYPTO_VERSION,
      '1',
    ]) {
      expect(aad).toContain(value);
    }
    expect(aad).not.toBe(
      serializeEnvelopeAad({
        context: envelopeObjectContext({ card: 'b' }),
        dekVersion: envelopeCryptoIds.dekVersion1,
      }),
    );
    expect(aad).not.toBe(
      serializeEnvelopeAad({
        context: envelopeObjectContext({ revision: 2 }),
        dekVersion: envelopeCryptoIds.dekVersion1,
      }),
    );
  });

  it('selects only the requested Vault and available DEK version', () => {
    const keyring = envelopeKeyring(2);
    expect(selectDekForWrite(keyring, controlPlaneIds.vaultA)).toMatchObject({
      kind: 'selected',
      metadata: { dekVersion: envelopeCryptoIds.dekVersion2 },
    });
    expect(
      selectDekForRead(
        keyring,
        controlPlaneIds.vaultA,
        envelopeCryptoIds.dekVersion1,
      ),
    ).toMatchObject({ kind: 'selected' });
    expect(
      selectDekForRead(
        keyring,
        controlPlaneIds.vaultB,
        envelopeCryptoIds.dekVersion1,
      ),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
    expect(
      selectDekForRead(
        keyring,
        controlPlaneIds.vaultA,
        envelopeCryptoIds.dekVersion3,
      ),
    ).toEqual({ kind: 'rejected', reason: 'unknown-dek-version' });
  });

  it('rotates to a consecutive write key while retaining mixed-version reads', () => {
    const current = envelopeKeyring();
    const next = envelopeDekMetadata(2);
    expect(planDekRotation(current, next)).toEqual({
      kind: 'rotated',
      keyring: envelopeKeyring(2),
    });
    expect(
      planDekRotation(current, {
        ...next,
        vaultId: controlPlaneIds.vaultB,
      }),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
  });

  it('rejects unsupported or malformed ciphertext versions at the boundary', () => {
    const valid = {
      format: ENVELOPE_CRYPTO_VERSION,
      algorithm: 'A256GCM',
      dekVersion: envelopeCryptoIds.dekVersion1,
      nonce: envelopeCryptoIds.nonceA,
      sealedPayload: 'AAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(decodeEnvelopeCiphertext(valid)).toEqual(valid);
    expect(() =>
      decodeEnvelopeCiphertext({ ...valid, format: 'fukamu-envelope/v2' }),
    ).toThrow();
    expect(() =>
      decodeEnvelopeCiphertext({ ...valid, plaintext: 'secret' }),
    ).toThrow();
  });
});
