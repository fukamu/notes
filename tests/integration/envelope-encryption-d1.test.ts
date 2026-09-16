import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['ENVELOPE'],
  });
  database = await miniflare.getD1Database('ENVELOPE');
  await runD1Migrations({
    database,
    manifest: productionMigrationManifest,
    appliedAt: 1_000,
  });
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 Envelope encryption metadata', () => {
  it('isolates versions by Vault and permits only one write key per Vault', async () => {
    await insertDek(controlPlaneIds.vaultA, 1, 1);
    await insertDek(controlPlaneIds.vaultA, 2, 0);
    await insertDek(controlPlaneIds.vaultB, 1, 1);

    const rows: unknown[][] = await database
      .prepare(
        'SELECT vault_id, dek_version, is_write_key FROM vault_dek_versions ORDER BY vault_id, dek_version',
      )
      .raw();
    expect(rows).toEqual([
      [controlPlaneIds.vaultA, 1, 1],
      [controlPlaneIds.vaultA, 2, 0],
      [controlPlaneIds.vaultB, 1, 1],
    ]);

    await expect(insertDek(controlPlaneIds.vaultA, 3, 1)).rejects.toThrow();
  });

  it('creates no raw key or plaintext content columns', async () => {
    const columns: unknown[][] = await database
      .prepare('PRAGMA table_info(vault_dek_versions)')
      .raw();
    expect(columns.map((column) => column[1])).toEqual([
      'vault_id',
      'dek_version',
      'kek_key_reference',
      'wrapped_dek',
      'is_write_key',
      'created_at',
    ]);
  });
});

async function insertDek(
  vaultId: string,
  version: number,
  isWriteKey: 0 | 1,
): Promise<void> {
  await database
    .prepare(
      'INSERT INTO vault_dek_versions(vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      vaultId,
      version,
      `fake-kek-${vaultId}-${version}`,
      `wrapped-${vaultId}-${version}`,
      isWriteKey,
      version * 1_000,
    )
    .run();
}
