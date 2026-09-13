import { describe, expect, it } from 'vitest';
import {
  createWebCryptoSyncV2CursorAuthenticator,
  SyncV2CursorConfigurationError,
  webCryptoSyncV2MutationFingerprints,
} from '@/server/sync-v2/web-crypto';
import {
  decodeSyncV2CursorClaims,
  SYNC_V2_CURSOR_VERSION,
} from '@/lib/sync/v2-cursor';
import { parseSyncV2Cursor } from '@/lib/sync/v2-protocol';
import { compatibilityIds } from '@/tests/fixtures/compatibility';
import { vaultContentContext } from '@/tests/fixtures/vault-content';
import { parseSyncV2MutationFingerprint } from '@/server/vault-content/sync-v2-public';

describe('Sync v2 Web Crypto adapters', () => {
  it('issues and verifies an authenticated opaque cursor', async () => {
    const authenticator = createWebCryptoSyncV2CursorAuthenticator(
      new Uint8Array(32).fill(0x41),
    );
    const context = vaultContentContext('a');
    const claims = decodeSyncV2CursorClaims({
      version: SYNC_V2_CURSOR_VERSION,
      vaultId: context.vaultId,
      deviceId: compatibilityIds.device,
      afterSequence: 2,
      highWatermark: 4,
    });
    const cursor = await authenticator.issue(claims);
    const verified = await authenticator.verify(cursor);
    expect(verified).toEqual({ kind: 'verified', claims });

    const suffix = cursor.endsWith('A') ? 'B' : 'A';
    const tampered = parseSyncV2Cursor(`${cursor.slice(0, -1)}${suffix}`);
    await expect(authenticator.verify(tampered)).resolves.toEqual({
      kind: 'rejected',
    });
    const other = createWebCryptoSyncV2CursorAuthenticator(
      new Uint8Array(32).fill(0x42),
    );
    await expect(other.verify(cursor)).resolves.toEqual({ kind: 'rejected' });
  });

  it('produces a valid deterministic SHA-256 mutation fingerprint', async () => {
    const first = await webCryptoSyncV2MutationFingerprints.digest('payload');
    const second = await webCryptoSyncV2MutationFingerprints.digest('payload');
    expect(parseSyncV2MutationFingerprint(first)).toBe(second);
    expect(parseSyncV2MutationFingerprint(first)).toHaveLength(43);
  });

  it('rejects short cursor secrets before importing a key', () => {
    expect(() =>
      createWebCryptoSyncV2CursorAuthenticator(new Uint8Array(31)),
    ).toThrow(SyncV2CursorConfigurationError);
  });
});
