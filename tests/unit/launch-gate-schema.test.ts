import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  launchAllowedUsers,
  launchConfig,
} from '@/server/launch-gate/d1-schema';
import {
  productionLaunchGateMigration,
  productionLaunchGateStatements,
} from '@/server/launch-gate/migration';
import { productionMigrationManifest } from '@/server/migrations/production';
import { termsConsentLedgerMigration } from '@/server/terms-consent/migration';

describe('Production Launch Gate schema', () => {
  it('models one global flag and an opaque user allowlist', () => {
    const config = getTableConfig(launchConfig);
    expect(config.name).toBe('launch_config');
    expect(config.checks.map((check) => check.name)).toEqual([
      'launch_config_singleton_check',
      'launch_config_public_access_check',
      'launch_config_updated_at_check',
    ]);

    const allowlist = getTableConfig(launchAllowedUsers);
    expect(allowlist.name).toBe('launch_allowed_users');
    expect(allowlist.foreignKeys).toHaveLength(0);
    expect(allowlist.checks.map((check) => check.name)).toEqual([
      'launch_allowed_users_user_id_check',
      'launch_allowed_users_created_at_check',
    ]);
  });

  it('ships disabled by default as the final forward-only migration', async () => {
    const source = await readFile(
      'drizzle/0017_production_launch_gate.sql',
      'utf8',
    );
    expect(source).toContain('public_access_enabled');
    expect(source).toContain('launch_allowed_users');
    expect(source).toContain('VALUES (1, 0, unixepoch() * 1000)');
    expect(source).not.toMatch(/email|phone|address/i);
    expect(
      productionMigrationManifest.indexOf(productionLaunchGateMigration),
    ).toBe(
      productionMigrationManifest.indexOf(termsConsentLedgerMigration) + 1,
    );
  });

  it('pins runtime migration statements to their checksum', () => {
    const checksum = createHash('sha256')
      .update(productionLaunchGateStatements.join('\n'))
      .digest('hex');
    expect(productionLaunchGateMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
