import { decodeOrThrow } from '../../lib/codec/core';
import type { SessionToken } from '../../lib/domain/identity';
import type { SessionCredentialResolver } from '../session-boundary';
import type { IdentityVaultControlPlane } from './public';
import { sessionTokenHashDecoder } from './records';

export type SessionTokenHashPort = {
  digest(token: SessionToken): Promise<unknown>;
};

export function createControlPlaneSessionResolver(input: {
  readonly controlPlane: Pick<
    IdentityVaultControlPlane,
    'findSessionByTokenHash'
  >;
  readonly hashes: SessionTokenHashPort;
}): SessionCredentialResolver {
  return {
    async findSessionByToken(token) {
      const hash = decodeOrThrow(
        sessionTokenHashDecoder,
        await input.hashes.digest(token),
        'session token hash',
      );
      return (await input.controlPlane.findSessionByTokenHash(hash))?.session;
    },
  };
}

export const webCryptoSessionTokenHashes: SessionTokenHashPort = {
  async digest(token) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token),
    );
    const binary = String.fromCharCode(...new Uint8Array(digest));
    return btoa(binary)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
  },
};
