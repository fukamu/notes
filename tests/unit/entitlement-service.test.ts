import { describe, expect, it } from 'vitest';
import { createFakeBillingModule } from '@/server/billing/fake';
import { createFakeEntitlementModule } from '@/server/entitlement/fake';
import {
  FUKAMU_OFFLINE_LEASE_DURATION_MS,
  fukamuOfflineLeasePolicy,
  paidPersonalVaultLimits,
  type OfflineLeasePolicy,
} from '@/server/entitlement/public';
import {
  beginCheckoutCommand,
  billingContext,
  invoicePaidFact,
  paymentFailedFact,
  paymentMethodUpdatedFact,
  reconciliationSnapshot,
  trialStartedFact,
} from '@/tests/fixtures/billing';
import {
  configuredOfflineLeasePolicy,
  entitlementIds,
  undecidedOfflineLeasePolicy,
} from '@/tests/fixtures/entitlement';

async function moduleWithTrial(policy: OfflineLeasePolicy) {
  const billing = createFakeBillingModule([billingContext()]);
  await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
  await billing.api.ingestVerifiedProviderFact(trialStartedFact());
  return {
    billing,
    entitlement: createFakeEntitlementModule({
      owners: [billingContext()],
      billing: billing.api,
      offlineLeasePolicy: policy,
    }),
  };
}

describe('Entitlement public port with fake persistence', () => {
  it('checks ownership before granting recovery or notes capabilities', async () => {
    const { entitlement } = await moduleWithTrial(undecidedOfflineLeasePolicy);
    await expect(
      entitlement.port.authorizeCapability(
        billingContext('b'),
        'billing-recovery',
        3_000,
      ),
    ).resolves.toEqual({
      kind: 'denied',
      capability: 'billing-recovery',
      reason: 'owner-mismatch',
    });
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-write',
        3_000,
      ),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'trial' });
  });

  it('exposes one confirmed limit view only while content access is active', async () => {
    const { billing, entitlement } = await moduleWithTrial(
      undecidedOfflineLeasePolicy,
    );
    await expect(
      entitlement.port.readLimits(billingContext(), 3_000),
    ).resolves.toEqual({
      kind: 'available',
      limits: paidPersonalVaultLimits,
      validUntil: trialStartedFact().trialEndsAt,
    });
    await billing.api.ingestVerifiedProviderFact(paymentFailedFact(5_000));
    await expect(
      entitlement.port.readLimits(billingContext(), 5_001),
    ).resolves.toEqual({ kind: 'denied', reason: 'payment-failed' });
  });

  it('keeps recovery routes open when billing is missing or unavailable', async () => {
    const missing = createFakeEntitlementModule({
      owners: [billingContext()],
      billing: {
        async readSubscription() {
          return undefined;
        },
      },
      offlineLeasePolicy: undecidedOfflineLeasePolicy,
    });
    await expect(
      missing.port.authorizeCapability(billingContext(), 'notes-read', 3_000),
    ).resolves.toMatchObject({
      kind: 'denied',
      reason: 'subscription-required',
    });
    await expect(
      missing.port.authorizeCapability(
        billingContext(),
        'account-delete',
        3_000,
      ),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'recovery' });

    const unavailable = createFakeEntitlementModule({
      owners: [billingContext()],
      billing: {
        async readSubscription() {
          throw new Error('billing unavailable');
        },
      },
      offlineLeasePolicy: undecidedOfflineLeasePolicy,
    });
    await expect(
      unavailable.port.authorizeCapability(
        billingContext(),
        'notes-sync',
        3_000,
      ),
    ).resolves.toMatchObject({
      kind: 'denied',
      reason: 'billing-unavailable',
    });
    await expect(
      unavailable.port.authorizeCapability(
        billingContext(),
        'billing-recovery',
        3_000,
      ),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'recovery' });
  });

  it('does not issue an offline lease until duration is explicitly configured', async () => {
    const { entitlement } = await moduleWithTrial(undecidedOfflineLeasePolicy);
    await expect(
      entitlement.port.issueOfflineLease(billingContext(), {
        leaseId: entitlementIds.leaseA,
        issuedAt: 3_000,
      }),
    ).resolves.toEqual({ kind: 'denied', reason: 'lease-policy-undecided' });
    expect(entitlement.repository.inspect().offlineLeases).toEqual([]);
  });

  it('issues leases idempotently and revokes them when payment fails', async () => {
    const { billing, entitlement } = await moduleWithTrial(
      fukamuOfflineLeasePolicy,
    );
    const command = { leaseId: entitlementIds.leaseA, issuedAt: 3_000 };
    await expect(
      entitlement.port.issueOfflineLease(billingContext(), command),
    ).resolves.toMatchObject({ kind: 'issued' });
    await expect(
      entitlement.port.issueOfflineLease(billingContext(), command),
    ).resolves.toMatchObject({ kind: 'replayed' });
    await expect(
      entitlement.port.authorizeOfflineCapability(
        billingContext(),
        'notes-write',
        entitlementIds.leaseA,
        4_000,
      ),
    ).resolves.toMatchObject({ kind: 'allowed' });

    await billing.api.ingestVerifiedProviderFact(paymentFailedFact(5_000));
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-read',
        5_001,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'payment-failed' });
    await expect(
      entitlement.port.authorizeOfflineCapability(
        billingContext(),
        'notes-read',
        entitlementIds.leaseA,
        5_002,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'lease-revoked' });

    await billing.api.ingestVerifiedProviderFact(invoicePaidFact(4_000));
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-read',
        5_003,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'payment-failed' });
    await billing.api.ingestVerifiedProviderFact(
      paymentMethodUpdatedFact(6_000),
    );
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-read',
        6_001,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'payment-failed' });
    await billing.api.ingestVerifiedProviderFact(invoicePaidFact(7_000));
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-read',
        7_001,
      ),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'paid' });
    await expect(
      entitlement.port.issueOfflineLease(billingContext(), {
        leaseId: entitlementIds.leaseB,
        issuedAt: 7_002,
      }),
    ).resolves.toMatchObject({
      kind: 'issued',
      lease: { expiresAt: 7_002 + FUKAMU_OFFLINE_LEASE_DURATION_MS },
    });
  });

  it('uses the reconciled Billing read model without provider-specific states', async () => {
    const { billing, entitlement } = await moduleWithTrial(
      undecidedOfflineLeasePolicy,
    );
    const snapshot = reconciliationSnapshot(8_000);
    await billing.api.reconcileVerifiedSnapshot(snapshot);
    await billing.api.reconcileVerifiedSnapshot(snapshot);
    await expect(
      entitlement.port.authorizeCapability(
        billingContext(),
        'notes-sync',
        8_001,
      ),
    ).resolves.toMatchObject({ kind: 'allowed', basis: 'paid' });
  });

  it('does not expose another Vault lease or reuse an identifier for another command', async () => {
    const { entitlement } = await moduleWithTrial(
      configuredOfflineLeasePolicy(60_000),
    );
    await entitlement.port.issueOfflineLease(billingContext(), {
      leaseId: entitlementIds.leaseA,
      issuedAt: 3_000,
    });
    await expect(
      entitlement.port.issueOfflineLease(billingContext(), {
        leaseId: entitlementIds.leaseA,
        issuedAt: 3_001,
      }),
    ).resolves.toEqual({ kind: 'denied', reason: 'identifier-conflict' });
    await expect(
      entitlement.port.authorizeOfflineCapability(
        billingContext('b'),
        'notes-read',
        entitlementIds.leaseA,
        4_000,
      ),
    ).resolves.toMatchObject({ kind: 'denied', reason: 'owner-mismatch' });
  });
});
