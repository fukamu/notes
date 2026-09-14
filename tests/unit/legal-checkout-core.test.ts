import { describe, expect, it } from 'vitest';
import {
  planContractEvidence,
  planContractOffer,
  serializeContractOffer,
} from '@/server/legal-checkout/core';
import {
  contractConfirmationCommandDecoder,
  contractOfferSnapshotDecoder,
} from '@/server/legal-checkout/public';
import { billingContext } from '@/tests/fixtures/billing';
import {
  contractCommand,
  contractDisclosure,
  contractEvidence,
  contractIds,
} from '@/tests/fixtures/legal-checkout';

describe('legal checkout pure core', () => {
  it('derives all final-confirmation financial terms from the decoded monthly offer', () => {
    const plan = planContractOffer(contractDisclosure());
    expect(plan).toMatchObject({
      kind: 'ready',
      offer: {
        schemaVersion: 1,
        offerVersion: 'legal-commerce-v1:2026-09-14',
        disclosureVersion: '2026-09-14',
        serviceName: 'FUKAMU Notes',
        quantity: 'one-personal-vault',
        priceYen: 1_280,
        billingPeriod: 'monthly',
        taxIncluded: true,
        trialDays: 14,
        trialPriceYen: 0,
        firstChargeDay: 15,
        renewalChargeYen: 1_280,
        annualEstimateYen: 15_360,
        automaticRenewal: true,
        paymentMethod: 'credit-card',
        servicePeriod: 'indefinite-until-cancelled',
        onlineLockPolicy: 'immediate-on-payment-failure-or-action-required',
        cancellationSeparateFromAccountDeletion: true,
      },
    });
    if (plan.kind !== 'ready') throw new Error('expected ready offer');
    const serialized = serializeContractOffer(plan.offer);
    expect(contractOfferSnapshotDecoder.decode(JSON.parse(serialized))).toEqual(
      {
        ok: true,
        value: plan.offer,
      },
    );
    expect(serializeContractOffer(plan.offer)).toBe(serialized);
  });

  it('uses one annual charge as the annual estimate and rejects malformed disclosure input', () => {
    expect(planContractOffer(contractDisclosure('annual'))).toMatchObject({
      kind: 'ready',
      offer: {
        priceYen: 12_800,
        renewalChargeYen: 12_800,
        annualEstimateYen: 12_800,
      },
    });
    expect(
      planContractOffer({ ...contractDisclosure(), unexpected: true }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-offer' });
  });

  it('decodes only submission identifiers, the presented hash, and explicit consent', () => {
    expect(
      contractConfirmationCommandDecoder.decode(contractCommand()).ok,
    ).toBe(true);
    for (const malformed of [
      { ...contractCommand(), priceYen: 1 },
      { ...contractCommand(), accountId: billingContext().accountId },
      { ...contractCommand(), consent: true },
      { ...contractCommand(), presentedOfferHash: 'sha256:short' },
    ]) {
      expect(contractConfirmationCommandDecoder.decode(malformed).ok).toBe(
        false,
      );
    }
  });

  it('requires affirmative consent and the current authoritative offer hash', () => {
    const base = evidenceInput();
    expect(
      planContractEvidence({
        ...base,
        command: contractCommand({ consent: { kind: 'not-affirmed' } }),
      }),
    ).toEqual({ kind: 'rejected', reason: 'consent-required' });
    expect(
      planContractEvidence({
        ...base,
        command: contractCommand({
          presentedOfferHash: contractIds.offerHashB,
        }),
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-offer' });
    expect(
      planContractEvidence({
        ...base,
        confirmedAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-command' });
  });

  it('appends once and replays only the same scoped immutable terms', () => {
    const base = evidenceInput();
    const created = planContractEvidence(base);
    expect(created).toMatchObject({
      kind: 'append',
      record: {
        evidenceId: contractIds.evidenceA,
        submissionId: contractIds.submissionA,
        offerHash: contractIds.offerHashA,
        consent: 'affirmed',
      },
    });
    if (created.kind !== 'append') throw new Error('expected append plan');
    expect(planContractEvidence({ ...base, existing: created.record })).toEqual(
      { kind: 'replay', record: created.record },
    );
    expect(
      planContractEvidence({
        ...base,
        existing: { ...created.record, offerHash: contractIds.offerHashB },
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });
  });

  it('rejects a repository result from another Vault instead of leaking it', () => {
    expect(
      planContractEvidence({
        ...evidenceInput(),
        existing: {
          ...contractEvidence(),
          scope: {
            accountId: billingContext('b').accountId,
            vaultId: billingContext('b').vaultId,
          },
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
  });
});

function evidenceInput() {
  const offerPlan = planContractOffer(contractDisclosure());
  if (offerPlan.kind !== 'ready') throw new Error('invalid offer fixture');
  return {
    context: billingContext(),
    command: contractCommand(),
    offer: offerPlan.offer,
    serializedOffer: serializeContractOffer(offerPlan.offer),
    authoritativeOfferHash: contractIds.offerHashA,
    evidenceId: contractIds.evidenceA,
    confirmedAt: 1_000,
    existing: undefined,
  } as const;
}
