import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { createActiveSession, revokeSession } from '@/server/core/session';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { identityVaultControlPlaneMigration } from '@/server/control-plane/migration';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import type { MigrationDefinition } from '@/server/migrations/core';
import {
  activeControlPlaneSession,
  controlPlaneContext,
  controlPlaneIds,
  controlPlaneTokenHash,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const identityVaultManifest = [identityVaultControlPlaneMigration] as const;

let miniflare: Miniflare;
let freshDatabase: TestDatabase;
let failureDatabase: TestDatabase;
let driftDatabase: TestDatabase;
let controlDatabase: TestDatabase;
let malformedDatabase: TestDatabase;

async function tableNames(database: TestDatabase): Promise<string[]> {
  const result: unknown[][] = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name",
    )
    .raw();
  return result.flatMap((row) => (typeof row[0] === 'string' ? [row[0]] : []));
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['FRESH', 'FAILURE', 'DRIFT', 'CONTROL', 'MALFORMED'],
  });
  freshDatabase = await miniflare.getD1Database('FRESH');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  driftDatabase = await miniflare.getD1Database('DRIFT');
  controlDatabase = await miniflare.getD1Database('CONTROL');
  malformedDatabase = await miniflare.getD1Database('MALFORMED');
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('explicit D1 migrations', () => {
  it('creates only the fresh Identity/Vault control plane and is idempotent', async () => {
    expect(
      await runD1Migrations({
        database: freshDatabase,
        manifest: identityVaultManifest,
        appliedAt: 1_000,
      }),
    ).toEqual({
      kind: 'applied',
      migrationIds: ['0002_identity_vault_control_plane'],
    });
    expect(await tableNames(freshDatabase)).toEqual([
      'accounts',
      'identities',
      'personal_vaults',
      'schema_migrations',
      'sessions',
    ]);
    expect(await tableNames(freshDatabase)).not.toEqual(
      expect.arrayContaining([
        'billing_subscriptions',
        'entitlements',
        'partitions',
        'wrapped_deks',
      ]),
    );
    expect(
      await runD1Migrations({
        database: freshDatabase,
        manifest: identityVaultManifest,
        appliedAt: 2_000,
      }),
    ).toEqual({ kind: 'up-to-date' });
  });

  it('rolls back a failed migration without recording or leaving partial DDL', async () => {
    const failingManifest: readonly MigrationDefinition[] = [
      {
        id: '0001_failure_fixture',
        checksum: `sha256:${'f'.repeat(64)}`,
        statements: [
          'CREATE TABLE partial_change(id TEXT)',
          'CREATE TABLE partial_change(id TEXT)',
        ],
      },
    ];
    await expect(
      runD1Migrations({
        database: failureDatabase,
        manifest: failingManifest,
        appliedAt: 1_000,
      }),
    ).rejects.toThrow();
    expect(await tableNames(failureDatabase)).toEqual(['schema_migrations']);
    const ledger: unknown[][] = await failureDatabase
      .prepare('SELECT migration_id FROM schema_migrations')
      .raw();
    expect(ledger).toEqual([]);
  });

  it('fails closed when the ledger checksum has drifted', async () => {
    await runD1Migrations({
      database: driftDatabase,
      manifest: identityVaultManifest,
      appliedAt: 1_000,
    });
    await driftDatabase
      .prepare('UPDATE schema_migrations SET checksum = ?')
      .bind(`sha256:${'f'.repeat(64)}`)
      .run();
    expect(
      await runD1Migrations({
        database: driftDatabase,
        manifest: identityVaultManifest,
        appliedAt: 2_000,
      }),
    ).toMatchObject({
      kind: 'rejected',
      reason: 'schema-drift',
      detail: 'checksum-mismatch:0002_identity_vault_control_plane',
    });
  });
});

describe('D1 Identity/Vault data owner', () => {
  it('enforces personal Vault, issuer+subject, hashed session, and revocation ownership', async () => {
    await runD1Migrations({
      database: controlDatabase,
      manifest: identityVaultManifest,
      appliedAt: 1_000,
    });
    await controlDatabase.prepare('PRAGMA foreign_keys = ON').run();
    const adapter = new D1IdentityVaultControlPlane(controlDatabase);
    const provision = personalAccountProvision();
    expect(await adapter.provisionPersonalAccount(provision)).toEqual({
      kind: 'applied',
    });
    expect(await adapter.findPersonalAccount(controlPlaneIds.accountA)).toEqual(
      {
        account: provision.account,
        vault: provision.vault,
      },
    );
    expect(
      await adapter.findIdentity({
        provider: provision.identity.provider,
        issuer: provision.identity.issuer,
        subject: provision.identity.subject,
      }),
    ).toEqual(provision.identity);

    const session = activeControlPlaneSession();
    expect(
      await adapter.createSession({
        session,
        tokenHash: controlPlaneTokenHash,
      }),
    ).toEqual({ kind: 'applied' });
    expect(await adapter.findSessionByTokenHash(controlPlaneTokenHash)).toEqual(
      { session, tokenHash: controlPlaneTokenHash },
    );
    const revocation = revokeSession(session, 1_500, 'logout');
    if (revocation.kind !== 'revoked') {
      throw new Error('invalid revocation fixture');
    }
    expect(
      await adapter.revokeSession(controlPlaneContext(), revocation.session),
    ).toEqual({ kind: 'applied' });
    expect(
      (await adapter.findSessionByTokenHash(controlPlaneTokenHash))?.session,
    ).toEqual(revocation.session);

    const duplicateIdentity = personalAccountProvision('b');
    await expect(
      adapter.provisionPersonalAccount({
        ...duplicateIdentity,
        identity: {
          ...duplicateIdentity.identity,
          issuer: provision.identity.issuer,
          subject: provision.identity.subject,
        },
      }),
    ).rejects.toThrow();
    expect(
      await adapter.findPersonalAccount(controlPlaneIds.accountB),
    ).toBeUndefined();

    await expect(
      controlDatabase
        .prepare(
          'INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES (?, ?, ?)',
        )
        .bind(controlPlaneIds.vaultB, controlPlaneIds.accountA, 1_000)
        .run(),
    ).rejects.toThrow();

    const mismatched = createActiveSession({
      ...session,
      accountId: controlPlaneIds.accountB,
    });
    if (mismatched.kind !== 'created') {
      throw new Error('invalid mismatch fixture');
    }
    expect(
      await adapter.createSession({
        session: mismatched.session,
        tokenHash: controlPlaneTokenHash,
      }),
    ).toEqual({ kind: 'rejected', reason: 'account-mismatch' });
  });

  it('decodes D1 rows from unknown and rejects malformed stored identity data', async () => {
    await runD1Migrations({
      database: malformedDatabase,
      manifest: identityVaultManifest,
      appliedAt: 1_000,
    });
    const adapter = new D1IdentityVaultControlPlane(malformedDatabase);
    const provision = personalAccountProvision();
    await adapter.provisionPersonalAccount(provision);
    await malformedDatabase
      .prepare("UPDATE identities SET identity_id = 'not-a-uuid'")
      .run();
    await expect(
      adapter.findIdentity({
        provider: provision.identity.provider,
        issuer: provision.identity.issuer,
        subject: provision.identity.subject,
      }),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);

    const session = activeControlPlaneSession();
    await adapter.createSession({ session, tokenHash: controlPlaneTokenHash });
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = ON')
      .run();
    await malformedDatabase
      .prepare('UPDATE sessions SET revoked_at = 1500')
      .run();
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = OFF')
      .run();
    await expect(
      adapter.findSessionByTokenHash(controlPlaneTokenHash),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });
});
