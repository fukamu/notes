import { describe, expect, it } from 'vitest';
import { createFakeBillingModule } from '@/server/billing/fake';
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

describe('Billing public API with fake persistence', () => {
  it('scopes checkout and read access to the authenticated owner', async () => {
    const { api } = createFakeBillingModule([billingContext()]);
    expect(
      await api.beginCheckout(billingContext('b'), beginCheckoutCommand('b')),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });

    const created = await api.beginCheckout(
      billingContext(),
      beginCheckoutCommand(),
    );
    expect(created).toMatchObject({ kind: 'applied' });
    expect(
      await api.beginCheckout(billingContext(), beginCheckoutCommand()),
    ).toMatchObject({ kind: 'replayed' });
    expect(await api.readSubscription(billingContext('b'))).toBeUndefined();
  });

  it('opens a checkout idempotently but rejects a changed provider reference', async () => {
    const { api } = createFakeBillingModule([billingContext()]);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    const command = {
      subscriptionId: billingIds.subscriptionA,
      checkoutIntentId: billingIds.checkoutA,
      providerCheckoutReference: billingIds.checkoutReferenceA,
      openedAt: 1_100,
    } as const;
    expect(
      await api.recordCheckoutOpened(billingContext(), command),
    ).toMatchObject({ kind: 'applied' });
    expect(
      await api.recordCheckoutOpened(billingContext(), command),
    ).toMatchObject({ kind: 'replayed' });
  });

  it('does not bind one provider checkout reference to two owners', async () => {
    const { api } = createFakeBillingModule([
      billingContext(),
      billingContext('b'),
    ]);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    await api.beginCheckout(billingContext('b'), beginCheckoutCommand('b'));
    await api.recordCheckoutOpened(billingContext(), {
      subscriptionId: billingIds.subscriptionA,
      checkoutIntentId: billingIds.checkoutA,
      providerCheckoutReference: billingIds.checkoutReferenceA,
      openedAt: 1_100,
    });
    expect(
      await api.recordCheckoutOpened(billingContext('b'), {
        subscriptionId: billingIds.subscriptionB,
        checkoutIntentId: billingIds.checkoutB,
        providerCheckoutReference: billingIds.checkoutReferenceA,
        openedAt: 1_100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });
  });

  it('deduplicates provider events and stores aggregate and receipt together', async () => {
    const { api, repository } = createFakeBillingModule([billingContext()]);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    const fact = trialStartedFact();
    expect(await api.ingestVerifiedProviderFact(fact)).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'trialing' }, version: 2 },
    });
    expect(await api.ingestVerifiedProviderFact(fact)).toMatchObject({
      kind: 'duplicate',
      facts: { version: 2 },
    });
    const inspection = repository.inspect();
    expect(inspection.subscriptions).toHaveLength(1);
    expect(inspection.providerEventReceipts).toHaveLength(1);
    expect(inspection.providerEventReceipts[0]).toMatchObject({
      subscriptionId: billingIds.subscriptionA,
      appliedVersion: 2,
      outcome: 'applied',
    });
  });

  it('does not let payment-method updates unlock a failed subscription', async () => {
    const { api } = createFakeBillingModule([billingContext()]);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    await api.ingestVerifiedProviderFact(trialStartedFact());
    await api.ingestVerifiedProviderFact(paymentFailedFact());
    const update = await api.ingestVerifiedProviderFact(
      paymentMethodUpdatedFact(6_000),
    );
    expect(update).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'delinquent' } },
    });
    expect(
      await api.ingestVerifiedProviderFact(invoicePaidFact(7_000)),
    ).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'active' } },
    });
  });

  it('deduplicates reconciliation checkpoints', async () => {
    const { api, repository } = createFakeBillingModule([billingContext()]);
    await api.beginCheckout(billingContext(), beginCheckoutCommand());
    const snapshot = reconciliationSnapshot();
    expect(await api.reconcileVerifiedSnapshot(snapshot)).toMatchObject({
      kind: 'applied',
      facts: { lifecycle: { kind: 'active' } },
    });
    expect(await api.reconcileVerifiedSnapshot(snapshot)).toMatchObject({
      kind: 'duplicate',
    });
    expect(repository.inspect().reconciliationCheckpoints).toHaveLength(1);
  });
});
