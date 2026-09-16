import { v7 as uuidv7 } from 'uuid';
import type {
  AccountDeletionContinuationCredentialsPort,
  AccountDeletionOperationIdGeneratorPort,
} from './public';

export function createWebCryptoAccountDeletionCredentials(
  derivationKey: CryptoKey,
): AccountDeletionContinuationCredentialsPort {
  return {
    async digest(value) {
      return encodeBase64Url(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      );
    },
    async deriveSecret(input) {
      const canonical = [
        'fukamu-account-deletion-continuation-v1',
        input.scope.accountId,
        input.scope.vaultId,
        input.idempotencyKey,
      ].join('\n');
      return encodeBase64Url(
        await crypto.subtle.sign(
          'HMAC',
          derivationKey,
          new TextEncoder().encode(canonical),
        ),
      );
    },
  };
}

export const uuidV7AccountDeletionOperationIds: AccountDeletionOperationIdGeneratorPort =
  {
    create: uuidv7,
  };

function encodeBase64Url(value: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(value));
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
