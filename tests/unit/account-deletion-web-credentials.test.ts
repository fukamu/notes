import { describe, expect, it } from 'vitest';
import {
  parseAccountDeletionContinuationSecret,
  parseAccountDeletionCredentialHash,
  parseAccountDeletionIdempotencyKey,
  parseAccountDeletionOperationId,
} from '@/server/account-deletion/public';
import {
  createWebCryptoAccountDeletionCredentials,
  uuidV7AccountDeletionOperationIds,
} from '@/server/account-deletion/web-credentials';
import { accountDeletionScopeFixture } from '@/tests/fixtures/account-deletion';

describe('account deletion Web Crypto credential adapter', () => {
  it('derives a deterministic scope-bound secret and stores only digest-shaped output', async () => {
    const adapter = createWebCryptoAccountDeletionCredentials(
      await derivationKey(),
    );
    const idempotencyKey = parseAccountDeletionIdempotencyKey('I'.repeat(43));
    const first = parseAccountDeletionContinuationSecret(
      await adapter.deriveSecret({
        scope: accountDeletionScopeFixture(),
        idempotencyKey,
      }),
    );
    const repeated = parseAccountDeletionContinuationSecret(
      await adapter.deriveSecret({
        scope: accountDeletionScopeFixture(),
        idempotencyKey,
      }),
    );
    const otherOwner = parseAccountDeletionContinuationSecret(
      await adapter.deriveSecret({
        scope: accountDeletionScopeFixture('b'),
        idempotencyKey,
      }),
    );
    expect(first).toBe(repeated);
    expect(first).not.toBe(otherOwner);
    expect(first).not.toContain(idempotencyKey);

    const digest = parseAccountDeletionCredentialHash(
      await adapter.digest(first),
    );
    expect(digest).toHaveLength(43);
    expect(digest).not.toBe(first);
  });

  it('generates boundary-valid UUIDv7 operation identifiers', () => {
    expect(() =>
      parseAccountDeletionOperationId(
        uuidV7AccountDeletionOperationIds.create(),
      ),
    ).not.toThrow();
  });
});

async function derivationKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('local-test-account-deletion-hmac-key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}
