import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  identities,
  personalVaults,
  schemaMigrations,
  sessions,
} from '@/server/control-plane/d1-schema';
import {
  identityVaultControlPlaneMigration,
  identityVaultControlPlaneStatements,
} from '@/server/control-plane/migration';

describe('Identity/Vault control-plane schema', () => {
  it('keeps feature-owned Drizzle tables aligned with the SQL contract', () => {
    const contract = [
      {
        table: accounts,
        columns: ['account_id', 'created_at'],
        indexes: [],
        checks: ['accounts_created_at_check'],
        foreignKeys: 0,
      },
      {
        table: personalVaults,
        columns: ['vault_id', 'account_id', 'created_at'],
        indexes: ['idx_personal_vaults_account', 'idx_personal_vaults_owner'],
        checks: ['personal_vaults_created_at_check'],
        foreignKeys: 1,
      },
      {
        table: identities,
        columns: [
          'identity_id',
          'account_id',
          'provider',
          'issuer',
          'subject',
          'created_at',
        ],
        indexes: ['idx_identities_issuer_subject', 'idx_identities_account'],
        checks: ['identities_provider_check', 'identities_created_at_check'],
        foreignKeys: 1,
      },
      {
        table: sessions,
        columns: [
          'session_id',
          'account_id',
          'vault_id',
          'token_hash',
          'session_epoch',
          'issued_at',
          'expires_at',
          'revoked_at',
          'revocation_reason',
        ],
        indexes: [
          'idx_sessions_token_hash',
          'idx_sessions_account',
          'idx_sessions_vault',
          'idx_sessions_expires_at',
        ],
        checks: [
          'sessions_epoch_check',
          'sessions_timeline_check',
          'sessions_revocation_check',
        ],
        foreignKeys: 1,
      },
      {
        table: schemaMigrations,
        columns: ['migration_id', 'checksum', 'applied_at'],
        indexes: [],
        checks: ['schema_migrations_applied_at_check'],
        foreignKeys: 0,
      },
    ];
    for (const expected of contract) {
      const actual = getTableConfig(expected.table);
      expect(actual.columns.map((column) => column.name)).toEqual(
        expected.columns,
      );
      expect(actual.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      expect(actual.checks.map((check) => check.name)).toEqual(expected.checks);
      expect(actual.foreignKeys).toHaveLength(expected.foreignKeys);
    }
  });

  it('keeps the checked-in Drizzle migration aligned with required schema names', async () => {
    const source = await readFile(
      'drizzle/0002_identity_vault_control_plane.sql',
      'utf8',
    );
    for (const marker of [
      'accounts',
      'personal_vaults',
      'identities',
      'sessions',
      'schema_migrations',
      'idx_personal_vaults_account',
      'idx_identities_issuer_subject',
      'idx_sessions_token_hash',
      'FOREIGN KEY (`account_id`,`vault_id`)',
      'sessions_revocation_check',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'billing_subscriptions',
      'entitlements',
      'partitions',
      'wrapped_deks',
    ]) {
      expect(source).not.toContain(excluded);
    }
  });

  it('pins the immutable manifest statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(identityVaultControlPlaneStatements.join('\n'))
      .digest('hex');
    expect(identityVaultControlPlaneMigration.checksum).toBe(
      `sha256:${checksum}`,
    );
  });
});
