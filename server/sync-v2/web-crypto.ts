import type {
  SyncV2CursorAuthenticator,
  SyncV2CursorClaims,
  SyncV2CursorVerification,
} from '../../lib/sync/v2-cursor';
import {
  parseSyncV2Cursor,
  type SyncV2Cursor,
} from '../../lib/sync/v2-protocol';
import type { SyncV2MutationFingerprintPort } from './public';

export const webCryptoSyncV2MutationFingerprints: SyncV2MutationFingerprintPort =
  {
    async digest(canonicalMutation) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalMutation),
      );
      return toBase64Url(new Uint8Array(digest));
    },
  };

export class SyncV2CursorConfigurationError extends Error {
  constructor() {
    super('Sync v2 cursor authentication is unavailable');
    this.name = 'SyncV2CursorConfigurationError';
  }
}

export function createWebCryptoSyncV2CursorAuthenticator(
  secret: unknown,
): SyncV2CursorAuthenticator {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < 32 ||
    secret.byteLength > 128
  ) {
    throw new SyncV2CursorConfigurationError();
  }
  const secretCopy = secret.slice();
  const key = crypto.subtle.importKey(
    'raw',
    secretCopy,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return {
    async issue(claims: SyncV2CursorClaims): Promise<SyncV2Cursor> {
      const payload = toBase64Url(
        new TextEncoder().encode(JSON.stringify(claims)),
      );
      const signature = await crypto.subtle.sign(
        'HMAC',
        await key,
        new TextEncoder().encode(payload),
      );
      return parseSyncV2Cursor(
        `${payload}.${toBase64Url(new Uint8Array(signature))}`,
      );
    },

    async verify(cursor: SyncV2Cursor): Promise<SyncV2CursorVerification> {
      const parts = cursor.split('.');
      if (parts.length !== 2) return { kind: 'rejected' };
      const [payload, encodedSignature] = parts;
      if (payload === undefined || encodedSignature === undefined) {
        return { kind: 'rejected' };
      }
      try {
        const accepted = await crypto.subtle.verify(
          'HMAC',
          await key,
          fromBase64Url(encodedSignature),
          new TextEncoder().encode(payload),
        );
        if (!accepted) return { kind: 'rejected' };
        const decoded = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: false,
        }).decode(fromBase64Url(payload));
        const claims: unknown = JSON.parse(decoded);
        return { kind: 'verified', claims };
      } catch {
        return { kind: 'rejected' };
      }
    },
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('invalid base64url');
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
