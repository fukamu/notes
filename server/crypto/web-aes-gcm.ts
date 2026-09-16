import { decodeOrThrow } from '../../lib/codec/core';
import {
  encryptionNonceDecoder,
  sealedPayloadDecoder,
  type SealedPayload,
} from './core';
import type { Aes256GcmPort, NonceGeneratorPort } from './ports';

export class EnvelopeAuthenticationError extends Error {
  constructor() {
    super('Envelope authentication failed');
    this.name = 'EnvelopeAuthenticationError';
  }
}

export const webCryptoNonceGenerator: NonceGeneratorPort = {
  async createNonce() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  },
};

export const webCryptoAes256Gcm: Aes256GcmPort = {
  async seal(input) {
    return input.key.use(async (keyBytes) => {
      const key = await crypto.subtle.importKey(
        'raw',
        toArrayBuffer(keyBytes),
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
      );
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(base64UrlDecode(input.nonce)),
          additionalData: toArrayBuffer(new TextEncoder().encode(input.aad)),
          tagLength: 128,
        },
        key,
        toArrayBuffer(input.plaintext),
      );
      return decodeOrThrow(
        sealedPayloadDecoder,
        base64UrlEncode(new Uint8Array(encrypted)),
        'AES-GCM sealed payload',
      );
    });
  },

  async open(input) {
    try {
      return await input.key.use(async (keyBytes) => {
        const key = await crypto.subtle.importKey(
          'raw',
          toArrayBuffer(keyBytes),
          { name: 'AES-GCM' },
          false,
          ['decrypt'],
        );
        const plaintext = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(base64UrlDecode(input.nonce)),
            additionalData: toArrayBuffer(new TextEncoder().encode(input.aad)),
            tagLength: 128,
          },
          key,
          toArrayBuffer(base64UrlDecode(input.sealedPayload)),
        );
        return new Uint8Array(plaintext);
      });
    } catch {
      throw new EnvelopeAuthenticationError();
    }
  },
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function decodeEncryptionNonce(input: unknown) {
  return decodeOrThrow(encryptionNonceDecoder, input, 'AES-GCM nonce');
}

export function decodeSealedPayload(input: unknown): SealedPayload {
  return decodeOrThrow(sealedPayloadDecoder, input, 'AES-GCM sealed payload');
}
