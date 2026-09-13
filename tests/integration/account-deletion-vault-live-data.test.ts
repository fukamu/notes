import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
} from '@/lib/codec/core';
import type { VaultId } from '@/lib/domain/identity';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { ENVELOPE_CRYPTO_VERSION } from '@/server/crypto/core';
import { D1EncryptedObjectMetadataPurge } from '@/server/encrypted-object/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import {
  controlPlaneIds,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const countDecoder = objectDecoder(
  { count: safeIntegerDecoder({ minimum: 0 }) },
  { unknownFields: 'allow' },
);
const keysDecoder = objectDecoder(
  {
    keys: stringDecoder({ maxLength: 10_000 }),
    earliest_created_at: safeIntegerDecoder({ minimum: 0 }),
    latest_created_at: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);
const snapshotDecoder = objectDecoder(
  { snapshot: stringDecoder({ maxLength: 1_000_000 }) },
  { unknownFields: 'allow' },
);

let miniflare: Miniflare;
let successDatabase: TestDatabase;
let failureDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['SUCCESS', 'FAILURE'],
  });
  successDatabase = await miniflare.getD1Database('SUCCESS');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  for (const database of [successDatabase, failureDatabase]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
    await seedTwoVaults(database);
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('account deletion Vault live D1 purge', () => {
  it('preserves another Vault bit-for-bit and leaves every private key in the delete outbox', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(successDatabase);
    const content = new D1VaultContentDirectory(successDatabase, controlPlane);
    const encrypted = new D1EncryptedObjectMetadataPurge(successDatabase);
    const scopeA = ownerScope('a');
    const beforeB = await vaultSnapshot(
      successDatabase,
      controlPlaneIds.vaultB,
    );

    await expect(
      encrypted.purgeVaultMetadata({
        scope: {
          accountId: controlPlaneIds.accountA,
          vaultId: controlPlaneIds.vaultB,
        },
        requestedAt: 1_200,
      }),
    ).resolves.toEqual({ kind: 'route-not-found' });
    await expect(
      content.purgeVaultLiveData({
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultB,
      }),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'owner-mismatch',
    });
    expect(await vaultSnapshot(successDatabase, controlPlaneIds.vaultB)).toBe(
      beforeB,
    );

    await expect(content.purgeVaultLiveData(scopeA)).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'object-inventory-not-empty',
    });
    expect(
      await liveRowCount(successDatabase, controlPlaneIds.vaultA),
    ).toBeGreaterThan(0);

    await expect(
      encrypted.purgeVaultMetadata({ scope: scopeA, requestedAt: 1_200 }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'purged' });
    await expect(
      readOutbox(successDatabase, controlPlaneIds.vaultA),
    ).resolves.toEqual({
      keys: [encryptedObjectIds.objectKeyA, encryptedObjectIds.objectKeyB]
        .sort()
        .join(','),
      earliest_created_at: 1_200,
      latest_created_at: 1_200,
    });
    expect(await vaultSnapshot(successDatabase, controlPlaneIds.vaultB)).toBe(
      beforeB,
    );

    await expect(
      encrypted.purgeVaultMetadata({ scope: scopeA, requestedAt: 1_300 }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'already-empty' });
    await expect(
      readOutbox(successDatabase, controlPlaneIds.vaultA),
    ).resolves.toMatchObject({
      earliest_created_at: 1_200,
      latest_created_at: 1_200,
    });

    await expect(content.purgeVaultLiveData(scopeA)).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'purged',
    });
    expect(await liveRowCount(successDatabase, controlPlaneIds.vaultA)).toBe(0);
    expect(await preservedControlCount(successDatabase, scopeA.vaultId)).toBe(
      2,
    );
    await expect(
      readOutbox(successDatabase, controlPlaneIds.vaultA),
    ).resolves.toMatchObject({
      keys: [encryptedObjectIds.objectKeyA, encryptedObjectIds.objectKeyB]
        .sort()
        .join(','),
    });
    expect(await vaultSnapshot(successDatabase, controlPlaneIds.vaultB)).toBe(
      beforeB,
    );

    await expect(
      encrypted.purgeVaultMetadata({ scope: scopeA, requestedAt: 1_300 }),
    ).resolves.toEqual({ kind: 'route-not-found' });
    await expect(content.purgeVaultLiveData(scopeA)).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'already-purged',
    });
    await expect(
      readOutbox(successDatabase, controlPlaneIds.vaultA),
    ).resolves.toMatchObject({
      earliest_created_at: 1_200,
      latest_created_at: 1_200,
    });
  });

  it('rolls back outbox insertion when metadata deletion fails, then resumes safely', async () => {
    const encrypted = new D1EncryptedObjectMetadataPurge(failureDatabase);
    const scope = ownerScope('a');
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_encrypted_metadata_delete
         BEFORE DELETE ON vault_encrypted_objects
         WHEN OLD.vault_id = '${controlPlaneIds.vaultA}'
         BEGIN SELECT RAISE(ABORT, 'injected metadata delete failure'); END`,
      )
      .run();

    await expect(
      encrypted.purgeVaultMetadata({ scope, requestedAt: 1_200 }),
    ).rejects.toThrow('injected metadata delete failure');
    expect(
      await tableCount(
        failureDatabase,
        'vault_object_delete_outbox',
        scope.vaultId,
      ),
    ).toBe(0);
    expect(await encryptedSourceCount(failureDatabase, scope.vaultId)).toBe(2);

    await failureDatabase
      .prepare('DROP TRIGGER fail_encrypted_metadata_delete')
      .run();
    await expect(
      encrypted.purgeVaultMetadata({ scope, requestedAt: 1_200 }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'purged' });
    expect(await encryptedSourceCount(failureDatabase, scope.vaultId)).toBe(0);
    expect(
      await tableCount(
        failureDatabase,
        'vault_object_delete_outbox',
        scope.vaultId,
      ),
    ).toBe(2);

    const controlPlane = new D1IdentityVaultControlPlane(failureDatabase);
    const content = new D1VaultContentDirectory(failureDatabase, controlPlane);
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_vault_route_delete
         BEFORE DELETE ON vault_partition_mappings
         WHEN OLD.vault_id = '${controlPlaneIds.vaultA}'
         BEGIN SELECT RAISE(ABORT, 'injected route delete failure'); END`,
      )
      .run();
    await expect(content.purgeVaultLiveData(scope)).rejects.toThrow(
      'injected route delete failure',
    );
    expect(await liveRowCount(failureDatabase, scope.vaultId)).toBeGreaterThan(
      0,
    );
    expect(
      await tableCount(
        failureDatabase,
        'vault_object_delete_outbox',
        scope.vaultId,
      ),
    ).toBe(2);
    await failureDatabase.prepare('DROP TRIGGER fail_vault_route_delete').run();
    await expect(content.purgeVaultLiveData(scope)).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'purged',
    });
    expect(await liveRowCount(failureDatabase, scope.vaultId)).toBe(0);
  });
});

function ownerScope(account: 'a' | 'b') {
  const context = vaultContentContext(account);
  return { accountId: context.accountId, vaultId: context.vaultId };
}

async function seedTwoVaults(database: TestDatabase): Promise<void> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const directory = new D1VaultContentDirectory(database, controlPlane);
  for (const account of ['a', 'b'] as const) {
    await controlPlane.provisionPersonalAccount(
      personalAccountProvision(account),
    );
    await directory.assignPartition(vaultContentContext(account), {
      partitionId: vaultContentIds.partitionHot,
      updatedAt: 1_000,
    });
    await seedVault(database, vaultContentContext(account).vaultId);
  }
}

async function seedVault(
  database: TestDatabase,
  vaultId: VaultId,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        'INSERT INTO vault_cards(vault_id, card_id, revision, updated_at) VALUES (?, ?, ?, ?)',
      )
      .bind(vaultId, vaultContentIds.card, vaultContentIds.revision1, 1_000),
    database
      .prepare(
        `INSERT INTO vault_mutation_receipts(
          vault_id, mutation_id, card_id, applied_revision, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        vaultId,
        vaultContentIds.mutation,
        vaultContentIds.card,
        vaultContentIds.revision1,
        1_010,
      ),
    database
      .prepare(
        `INSERT INTO vault_conflicts(
          vault_id, conflict_id, card_id, server_revision, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        vaultId,
        vaultContentIds.conflict,
        vaultContentIds.card,
        vaultContentIds.revision1,
        1_020,
      ),
    database
      .prepare(
        `INSERT INTO vault_sync_v2_states(
          vault_id, next_display_id, next_change_sequence
        ) VALUES (?, 2, 2)`,
      )
      .bind(vaultId),
    database
      .prepare(
        `INSERT INTO vault_card_display_ids(
          vault_id, card_id, official_display_id
        ) VALUES (?, ?, 1)`,
      )
      .bind(vaultId, vaultContentIds.card),
    database
      .prepare(
        `INSERT INTO vault_sync_v2_commits(
          vault_id, mutation_id, fingerprint, card_id, applied_revision,
          committed_at, state
        ) VALUES (?, ?, ?, ?, ?, 1030, 'committed')`,
      )
      .bind(
        vaultId,
        vaultContentIds.mutation,
        'A'.repeat(43),
        vaultContentIds.card,
        vaultContentIds.revision1,
      ),
    database
      .prepare(
        `INSERT INTO vault_sync_v2_changes(
          vault_id, sequence, change_kind, card_id, conflict_id, revision,
          official_display_id, occurred_at
        ) VALUES (?, 1, 'card-upsert', ?, NULL, ?, 1, 1030)`,
      )
      .bind(vaultId, vaultContentIds.card, vaultContentIds.revision1),
    database
      .prepare(
        `INSERT INTO vault_encrypted_objects(
          vault_id, object_type, object_id, object_revision, write_id,
          object_key, plaintext_bytes, ciphertext_bytes, crypto_version,
          dek_version, created_at
        ) VALUES (?, 'card', ?, ?, ?, ?, 16, 128, ?, ?, 1040)`,
      )
      .bind(
        vaultId,
        vaultContentIds.card,
        envelopeCryptoIds.objectRevision1,
        encryptedObjectIds.writeA,
        encryptedObjectIds.objectKeyA,
        ENVELOPE_CRYPTO_VERSION,
        envelopeCryptoIds.dekVersion1,
      ),
    database
      .prepare(
        `INSERT INTO vault_encrypted_write_intents(
          vault_id, write_id, object_type, object_id, expected_revision,
          object_revision, object_key, plaintext_bytes, crypto_version,
          dek_version, created_at
        ) VALUES (?, ?, 'conflict', ?, NULL, ?, ?, 16, ?, ?, 1050)`,
      )
      .bind(
        vaultId,
        encryptedObjectIds.writeB,
        vaultContentIds.conflict,
        envelopeCryptoIds.objectRevision1,
        encryptedObjectIds.objectKeyB,
        ENVELOPE_CRYPTO_VERSION,
        envelopeCryptoIds.dekVersion1,
      ),
    database
      .prepare(
        `INSERT INTO vault_dek_versions(
          vault_id, dek_version, kek_key_reference, wrapped_dek,
          is_write_key, created_at
        ) VALUES (?, ?, 'test-kek', 'wrapped-test-dek', 1, 1060)`,
      )
      .bind(vaultId, envelopeCryptoIds.dekVersion1),
  ]);
}

async function readOutbox(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT
        COALESCE(GROUP_CONCAT(object_key, ','), '') AS keys,
        COALESCE(MIN(created_at), 0) AS earliest_created_at,
        COALESCE(MAX(created_at), 0) AS latest_created_at
       FROM (
         SELECT object_key, created_at
         FROM vault_object_delete_outbox
         WHERE vault_id = ?
         ORDER BY object_key
       )`,
    )
    .bind(vaultId)
    .first();
  return decodeOrThrow(keysDecoder, raw, 'test outbox inventory');
}

async function liveRowCount(database: TestDatabase, vaultId: VaultId) {
  const tables = [
    'vault_partition_mappings',
    'vault_cards',
    'vault_mutation_receipts',
    'vault_conflicts',
    'vault_sync_v2_states',
    'vault_card_display_ids',
    'vault_sync_v2_commits',
    'vault_sync_v2_changes',
    'vault_encrypted_objects',
    'vault_encrypted_write_intents',
  ] as const;
  let count = 0;
  for (const table of tables)
    count += await tableCount(database, table, vaultId);
  return count;
}

async function encryptedSourceCount(database: TestDatabase, vaultId: VaultId) {
  return (
    (await tableCount(database, 'vault_encrypted_objects', vaultId)) +
    (await tableCount(database, 'vault_encrypted_write_intents', vaultId))
  );
}

async function tableCount(
  database: TestDatabase,
  table:
    | 'vault_partition_mappings'
    | 'vault_cards'
    | 'vault_mutation_receipts'
    | 'vault_conflicts'
    | 'vault_sync_v2_states'
    | 'vault_card_display_ids'
    | 'vault_sync_v2_commits'
    | 'vault_sync_v2_changes'
    | 'vault_encrypted_objects'
    | 'vault_encrypted_write_intents'
    | 'vault_object_delete_outbox',
  vaultId: VaultId,
) {
  const raw: unknown = await database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE vault_id = ?`)
    .bind(vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, `test ${table} count`).count;
}

async function preservedControlCount(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM personal_vaults WHERE vault_id = ?)
        + (SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = ?) AS count`,
    )
    .bind(vaultId, vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, 'test preserved control count').count;
}

async function vaultSnapshot(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(row_value, char(10)), '') AS snapshot
       FROM (
         SELECT 'route|' || quote(account_id) || '|' || quote(partition_id)
           || '|' || quote(routing_revision) || '|' || quote(updated_at) AS row_value
         FROM vault_partition_mappings WHERE vault_id = ?
         UNION ALL
         SELECT 'card|' || quote(card_id) || '|' || quote(revision)
           || '|' || quote(updated_at)
         FROM vault_cards WHERE vault_id = ?
         UNION ALL
         SELECT 'receipt|' || quote(mutation_id) || '|' || quote(card_id)
           || '|' || quote(applied_revision) || '|' || quote(created_at)
         FROM vault_mutation_receipts WHERE vault_id = ?
         UNION ALL
         SELECT 'conflict|' || quote(conflict_id) || '|' || quote(card_id)
           || '|' || quote(server_revision) || '|' || quote(created_at)
         FROM vault_conflicts WHERE vault_id = ?
         UNION ALL
         SELECT 'sync-state|' || quote(next_display_id) || '|'
           || quote(next_change_sequence)
         FROM vault_sync_v2_states WHERE vault_id = ?
         ORDER BY row_value
       )`,
    )
    .bind(vaultId, vaultId, vaultId, vaultId, vaultId)
    .first();
  const secondaryRaw: unknown = await database
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(row_value, char(10)), '') AS snapshot
       FROM (
         SELECT 'display|' || quote(card_id) || '|' || quote(official_display_id) AS row_value
         FROM vault_card_display_ids WHERE vault_id = ?
         UNION ALL
         SELECT 'commit|' || quote(mutation_id) || '|' || quote(fingerprint)
           || '|' || quote(card_id) || '|' || quote(applied_revision)
           || '|' || quote(committed_at) || '|' || quote(state)
         FROM vault_sync_v2_commits WHERE vault_id = ?
         UNION ALL
         SELECT 'change|' || quote(sequence) || '|' || quote(change_kind)
           || '|' || quote(card_id) || '|' || quote(conflict_id)
           || '|' || quote(revision) || '|' || quote(official_display_id)
           || '|' || quote(occurred_at)
         FROM vault_sync_v2_changes WHERE vault_id = ?
         UNION ALL
         SELECT 'object|' || quote(object_type) || '|' || quote(object_id)
           || '|' || quote(object_revision) || '|' || quote(write_id)
           || '|' || quote(object_key) || '|' || quote(plaintext_bytes)
           || '|' || quote(ciphertext_bytes) || '|' || quote(crypto_version)
           || '|' || quote(dek_version) || '|' || quote(created_at)
         FROM vault_encrypted_objects WHERE vault_id = ?
         UNION ALL
         SELECT 'intent|' || quote(write_id) || '|' || quote(object_type)
           || '|' || quote(object_id) || '|' || quote(expected_revision)
           || '|' || quote(object_revision) || '|' || quote(object_key)
           || '|' || quote(plaintext_bytes) || '|' || quote(crypto_version)
           || '|' || quote(dek_version) || '|' || quote(created_at)
         FROM vault_encrypted_write_intents WHERE vault_id = ?
         ORDER BY row_value
       )`,
    )
    .bind(vaultId, vaultId, vaultId, vaultId, vaultId)
    .first();
  const dekRaw: unknown = await database
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(row_value, char(10)), '') AS snapshot
       FROM (
         SELECT 'dek|' || quote(dek_version) || '|' || quote(kek_key_reference)
           || '|' || quote(wrapped_dek) || '|' || quote(is_write_key)
           || '|' || quote(created_at) AS row_value
         FROM vault_dek_versions WHERE vault_id = ?
         ORDER BY row_value
       )`,
    )
    .bind(vaultId)
    .first();
  const live = decodeOrThrow(snapshotDecoder, raw, 'test Vault snapshot');
  const secondary = decodeOrThrow(
    snapshotDecoder,
    secondaryRaw,
    'test Vault secondary snapshot',
  );
  const dek = decodeOrThrow(snapshotDecoder, dekRaw, 'test Vault DEK snapshot');
  return `${live.snapshot}\n${secondary.snapshot}\n${dek.snapshot}`;
}
