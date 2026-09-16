import { describe, expect, it } from 'vitest';
import {
  DestroyedDataEncryptionKeyError,
  createDataEncryptionKey,
} from '@/server/crypto/key-material';
import {
  decodeEncryptionNonce,
  webCryptoAes256Gcm,
} from '@/server/crypto/web-aes-gcm';

describe('Web Crypto AES-256-GCM adapter', () => {
  it('matches the NIST AES-256-GCM zero-key vector and round-trips', async () => {
    const key = createDataEncryptionKey(new Uint8Array(32));
    const plaintext = new Uint8Array(16);
    const sealed = await webCryptoAes256Gcm.seal({
      key,
      nonce: decodeEncryptionNonce('AAAAAAAAAAAAAAAA'),
      aad: '',
      plaintext,
    });
    expect(bytesToHex(base64UrlDecode(sealed))).toBe(
      'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919',
    );
    await expect(
      webCryptoAes256Gcm.open({
        key,
        nonce: decodeEncryptionNonce('AAAAAAAAAAAAAAAA'),
        aad: '',
        sealedPayload: sealed,
      }),
    ).resolves.toEqual(plaintext);
    key.destroy();
    expect(key.destroyed).toBe(true);
    expect(String(key)).toBe('[REDACTED data encryption key]');
    expect(JSON.stringify(key)).toBe('"[REDACTED data encryption key]"');
    expect(Object.keys(key)).toEqual([]);
    await expect(key.use(async () => undefined)).rejects.toBeInstanceOf(
      DestroyedDataEncryptionKeyError,
    );
  });
});

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
