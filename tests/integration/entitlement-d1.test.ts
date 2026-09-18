import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createD1BillingApi } from '@/server/billing/d1-adapter';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import {
  D1EntitlementRepository,
  createD1EntitlementPort,
} from '@/server/entitlement/d1-adapter';
import {
  FUKAMU_OFFLINE_LEASE_DURATION_MS,
  fukamuOfflineLeasePolicy,
} from '@/server/entitlement/public';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  beginCheckoutCommand,
  billingContext,
  invoicePaidFact,
  paymentFailedFact,
  paymentMethodUpdatedFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  entitlementIds,
  undecidedOfflineLeasePolicy,
} from '@/tests/fixtures/entitlement';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let lifecycleDatabase: TestDatabase;
let rollbackDatabase: TestDatabase;
let malformedDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['LIFECYCLE', 'ROLLBACK', 'MALFORMED'],
  });
  lifecycleDatabase = await miniflare.getD1Database('LIFECYCLE');
  rollbackDatabase = await miniflare.getD1Database('ROLLBACK');
  malformedDatabase = await miniflare.getD1Database('MALFORMED');
  for (const database of [
    lifecycleDatabase,
    rollbackDatabase,
    malformedDatabase,
  ]) {
    expect(
      await runD1Migrations({
        database,
        manifest: productionMigrationManifest,
        appliedAt: 1_000,
      }),
    ).toMatchObject({ kind: 'applied' });
    await database.prepare('PRAGMA foreign_keys = ON').run();
    const controlPlane = new D1IdentityVaultControlPlane(database);
    await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
    await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  }
  expect(
    await runD1Migrations({
      database: lifecycleDatabase,
      manifest: productionMigrationManifest,
      appliedAt: 2_000,
    }),
  ).toEqual({ kind: 'up-to-date' });
});

afterAll(async () => {
  await miniflare.dispose();
});

function modulesFor(database: TestDatabase, policy = fukamuOfflineLeasePolicy) {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const billing = createD1BillingApi(database, controlPlane);
  return {
    billing,
    entitlement: createD1EntitlementPort({
      database,
      controlPlane,
      billing,
      offlineLeasePolicy: policy,
    }),
  };
}

async function startTrial(database: TestDatabase) {
  const modules = modulesFor(database);
  await modules.billing.beginCheckout(billingContext(), beginCheckoutCommand());
  await modules.billing.ingestVerifiedProviderFact(trialStartedFact());
  return modules;
}

describe('D1 Entitlement public contract', () => {
  it('projects trial access, limits, and tenant-scoped offline leases', async () => {
    const { entitlement } = await startTrial(lifecycleDatabase);
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-write', 3_000),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'trial' });
    await expect(
      entitlement.readLimits(billingContext(), 3_000),
    ).resolves.toMatchObject({
      kind: 'available',
      limits: { activeCards: 10_000 },
    });
    const command = { leaseId: entitlementIds.leaseA, issuedAt: 3_000 };
    await expect(
      entitlement.issueOfflineLease(billingContext(), command),
    ).resolves.toMatchObject({ kind: 'issued' });
    await expect(
      entitlement.issueOfflineLease(billingContext(), command),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      entitlement.authorizeOfflineCapability(
        billingContext('b'),
        'notes-read',
        entitlementIds.leaseA,
        4_000,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'lease-not-found' });
    await expect(
      entitlement.authorizeOfflineCapability(
        billingContext(),
        'notes-write',
        entitlementIds.leaseA,
        command.issuedAt + FUKAMU_OFFLINE_LEASE_DURATION_MS - 1,
      ),
    ).resolves.toMatchObject({ kind: 'allowed' });
    await expect(
      entitlement.authorizeOfflineCapability(
        billingContext(),
        'notes-write',
        entitlementIds.leaseA,
        command.issuedAt + FUKAMU_OFFLINE_LEASE_DURATION_MS,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'lease-expired' });
  });

  it('atomically projects payment failure and revokes active leases', async () => {
    const { billing, entitlement } = modulesFor(lifecycleDatabase);
    await entitlement.issueOfflineLease(billingContext(), {
      leaseId: entitlementIds.leaseB,
      issuedAt: 3_100,
    });
    await billing.ingestVerifiedProviderFact(paymentFailedFact(5_000));
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-sync', 5_001),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'payment-failed' });
    await expect(
      entitlement.authorizeOfflineCapability(
        billingContext(),
        'notes-read',
        entitlementIds.leaseB,
        5_002,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'lease-revoked' });

    await billing.ingestVerifiedProviderFact(paymentMethodUpdatedFact(6_000));
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-read', 6_001),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'payment-failed' });
    await billing.ingestVerifiedProviderFact(invoicePaidFact(7_000));
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-read', 7_001),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'paid' });
  });

  it('does not create a lease when policy duration is undecided', async () => {
    const { billing } = modulesFor(lifecycleDatabase);
    const controlPlane = new D1IdentityVaultControlPlane(lifecycleDatabase);
    const entitlement = createD1EntitlementPort({
      database: lifecycleDatabase,
      controlPlane,
      billing,
      offlineLeasePolicy: undecidedOfflineLeasePolicy,
    });
    await expect(
      entitlement.issueOfflineLease(billingContext(), {
        leaseId: entitlementIds.leaseA,
        issuedAt: 8_000,
      }),
    ).resolves.toEqual({ kind: 'denied', reason: 'lease-policy-undecided' });
  });

  it('rolls back a locked projection when lease revocation persistence fails', async () => {
    const { billing, entitlement } = await startTrial(rollbackDatabase);
    await entitlement.authorizeCapability(
      billingContext(),
      'notes-read',
      3_000,
    );
    await entitlement.issueOfflineLease(billingContext(), {
      leaseId: entitlementIds.leaseA,
      issuedAt: 3_100,
    });
    await rollbackDatabase
      .prepare(
        `CREATE TRIGGER fail_entitlement_lease_revoke
         BEFORE UPDATE OF revoked_at ON entitlement_offline_leases
         BEGIN SELECT RAISE(ABORT, 'lease revoke failure'); END`,
      )
      .run();
    await billing.ingestVerifiedProviderFact(paymentFailedFact(5_000));
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-read', 5_001),
    ).resolves.toMatchObject({
      kind: 'denied',
      reason: 'entitlement-unavailable',
    });
    const repository = new D1EntitlementRepository(rollbackDatabase);
    await expect(
      repository.findProjection(billingContext()),
    ).resolves.toMatchObject({ state: { kind: 'trial-active' } });
    await expect(
      repository.findOfflineLease(billingContext(), entitlementIds.leaseA),
    ).resolves.toMatchObject({ revokedAt: null });
  });

  it('decodes projection rows from unknown and fails closed on malformed state', async () => {
    const { entitlement } = await startTrial(malformedDatabase);
    await entitlement.authorizeCapability(
      billingContext(),
      'notes-read',
      3_000,
    );
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = ON')
      .run();
    await malformedDatabase
      .prepare(
        "UPDATE entitlement_projections SET state = 'paid-active', valid_until = NULL",
      )
      .run();
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = OFF')
      .run();
    await expect(
      entitlement.authorizeCapability(billingContext(), 'notes-read', 3_001),
    ).resolves.toMatchObject({
      kind: 'denied',
      reason: 'entitlement-unavailable',
    });
  });
});
