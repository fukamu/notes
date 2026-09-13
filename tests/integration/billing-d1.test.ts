import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  D1BillingRepository,
  createD1BillingApi,
} from '@/server/billing/d1-adapter';
import { planVerifiedProviderFact } from '@/server/billing/core';
import type { ProviderEventReceipt } from '@/server/billing/records';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  beginCheckoutCommand,
  billingContext,
  billingIds,
  invoicePaidFact,
  paymentFailedFact,
  paymentMethodUpdatedFact,
  reconciliationSnapshot,
  trialStartedFact,
} from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let lifecycleDatabase: TestDatabase;
let rollbackDatabase: TestDatabase;
let casDatabase: TestDatabase;
let malformedDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['LIFECYCLE', 'ROLLBACK', 'CAS', 'MALFORMED'],
  });
  lifecycleDatabase = await miniflare.getD1Database('LIFECYCLE');
  rollbackDatabase = await miniflare.getD1Database('ROLLBACK');
  casDatabase = await miniflare.getD1Database('CAS');
  malformedDatabase = await miniflare.getD1Database('MALFORMED');
  for (const database of [
    lifecycleDatabase,
    rollbackDatabase,
    casDatabase,
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

function apiFor(database: TestDatabase) {
  return createD1BillingApi(
    database,
    new D1IdentityVaultControlPlane(database),
  );
}

describe('D1 Billing public contract', () => {
  it('keeps one subscription per Account/Vault and rejects cross-owner access', async () => {
    const api = apiFor(lifecycleDatabase);
    expect(
      await api.beginCheckout(billingContext(), beginCheckoutCommand()),
    ).toMatchObject({ kind: 'applied' });
    expect(
      await api.beginCheckout(billingContext(), beginCheckoutCommand()),
    ).toMatchObject({ kind: 'replayed' });
    expect(await api.readSubscription(billingContext('b'))).toBeUndefined();

    expect(
      await api.recordCheckoutOpened(billingContext('b'), {
        subscriptionId: billingIds.subscriptionA,
        checkoutIntentId: billingIds.checkoutA,
        providerCheckoutReference: billingIds.checkoutReferenceA,
        openedAt: 1_100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-found' });
  });

  it('deduplicates and safely orders normalized facts without unlocking on card update', async () => {
    const api = apiFor(lifecycleDatabase);
    const trial = trialStartedFact();
    expect(await api.ingestVerifiedProviderFact(trial)).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'trialing' } },
    });
    expect(await api.ingestVerifiedProviderFact(trial)).toMatchObject({
      kind: 'duplicate',
    });
    expect(
      await api.ingestVerifiedProviderFact(paymentFailedFact(5_000)),
    ).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'delinquent' } },
    });
    expect(
      await api.ingestVerifiedProviderFact(paymentMethodUpdatedFact(6_000)),
    ).toMatchObject({ facts: { lifecycle: { kind: 'delinquent' } } });
    expect(
      await api.ingestVerifiedProviderFact(invoicePaidFact(4_000)),
    ).toMatchObject({ facts: { lifecycle: { kind: 'delinquent' } } });
    expect(
      await api.ingestVerifiedProviderFact(invoicePaidFact(7_000)),
    ).toMatchObject({ facts: { lifecycle: { kind: 'active' } } });

    expect(
      await api.ingestVerifiedProviderFact({
        ...paymentFailedFact(8_000),
        providerCustomerReference: billingIds.customerB,
      }),
    ).toEqual({ kind: 'rejected', reason: 'mapping-mismatch' });
  });

  it('records reconcile checkpoints and ignores an older snapshot', async () => {
    const api = apiFor(lifecycleDatabase);
    const current = reconciliationSnapshot(10_000);
    expect(await api.reconcileVerifiedSnapshot(current)).toMatchObject({
      kind: 'applied',
    });
    expect(await api.reconcileVerifiedSnapshot(current)).toMatchObject({
      kind: 'duplicate',
    });
    expect(
      await api.reconcileVerifiedSnapshot(reconciliationSnapshot(9_000)),
    ).toMatchObject({ kind: 'ignored', reason: 'stale' });
  });

  it('rejects provider references already bound to another owner', async () => {
    const api = apiFor(lifecycleDatabase);
    await api.beginCheckout(billingContext('b'), beginCheckoutCommand('b'));
    expect(
      await api.ingestVerifiedProviderFact({
        ...trialStartedFact(12_000),
        subscriptionId: billingIds.subscriptionB,
      }),
    ).toEqual({ kind: 'rejected', reason: 'mapping-mismatch' });
  });

  it('rolls back aggregate changes when receipt persistence fails', async () => {
    const api = apiFor(rollbackDatabase);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    await rollbackDatabase
      .prepare(
        `CREATE TRIGGER fail_billing_receipt
         BEFORE INSERT ON billing_provider_event_receipts
         BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`,
      )
      .run();
    await expect(
      api.ingestVerifiedProviderFact(trialStartedFact()),
    ).rejects.toThrow();
    expect(await api.readSubscription(billingContext())).toMatchObject({
      version: 1,
      lifecycle: { kind: 'checkout-pending' },
    });
    const receipts: unknown[][] = await rollbackDatabase
      .prepare('SELECT provider_event_id FROM billing_provider_event_receipts')
      .raw();
    expect(receipts).toEqual([]);
  });

  it('rejects a stale CAS plan without recording its receipt', async () => {
    const api = apiFor(casDatabase);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    const repository = new D1BillingRepository(casDatabase);
    const current = await repository.findById(billingIds.subscriptionA);
    if (current === undefined) throw new Error('missing Billing fixture');
    const firstFact = trialStartedFact(2_000);
    const secondFact = trialStartedFact(3_000);
    const first = planVerifiedProviderFact(current, firstFact);
    const second = planVerifiedProviderFact(current, secondFact);
    if (first.kind !== 'apply' || second.kind !== 'apply') {
      throw new Error('invalid fact plans');
    }
    const receipt = (
      fact: typeof firstFact,
      appliedVersion: typeof first.record.version,
    ): ProviderEventReceipt => ({
      provider: fact.provider,
      eventId: fact.eventId,
      subscriptionId: fact.subscriptionId,
      factKind: fact.kind,
      outcome: 'applied',
      occurredAt: fact.occurredAt,
      appliedVersion,
      recordedAt: fact.recordedAt,
    });
    expect(
      await repository.commitProviderFact({
        expectedRecord: current,
        nextRecord: first.record,
        receipt: receipt(firstFact, first.record.version),
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      await repository.commitProviderFact({
        expectedRecord: current,
        nextRecord: second.record,
        receipt: receipt(secondFact, second.record.version),
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await repository.findProviderEventReceipt(
        secondFact.provider,
        secondFact.eventId,
      ),
    ).toBeUndefined();
  });

  it('decodes stored rows from unknown and fails closed on malformed state', async () => {
    const api = apiFor(malformedDatabase);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = ON')
      .run();
    await malformedDatabase
      .prepare("UPDATE billing_subscriptions SET status = 'active'")
      .run();
    await malformedDatabase
      .prepare('PRAGMA ignore_check_constraints = OFF')
      .run();
    await expect(api.readSubscription(billingContext())).rejects.toBeInstanceOf(
      BoundaryDecodeError,
    );
  });
});
