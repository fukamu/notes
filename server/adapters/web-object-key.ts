import { parseOpaqueObjectKey } from '../encrypted-object/core';
import type { OpaqueObjectKeyGeneratorPort } from '../encrypted-object/ports';

export const webCryptoObjectKeyGenerator: OpaqueObjectKeyGeneratorPort = {
  async createObjectKey() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return parseOpaqueObjectKey(`obj_v1_${base64UrlEncode(bytes)}`);
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
