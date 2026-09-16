import { describe, expect, it, vi } from 'vitest';
import { createFakeContractEvidenceRepository } from '@/server/legal-checkout/fake';
import {
  contractOfferHashDecoder,
  type ContractEvidenceRepository,
  type ContractOfferHasherPort,
} from '@/server/legal-checkout/public';
import { createContractEvidenceService } from '@/server/legal-checkout/service';
import { createWebCryptoContractOfferHasher } from '@/server/legal-checkout/web-crypto-hash';
import { billingContext } from '@/tests/fixtures/billing';
import {
  contractCommand,
  contractDisclosure,
  contractEvidence,
  contractIds,
} from '@/tests/fixtures/legal-checkout';

describe('contract evidence service', () => {
  it('prepares a real SHA-256 offer and records/replays one scoped confirmation', async () => {
    const repository = createFakeContractEvidenceRepository();
    const service = createContractEvidenceService({
      repository,
      hasher: createWebCryptoContractOfferHasher(globalThis.crypto.subtle),
    });
    const prepared = await service.prepareOffer(contractDisclosure());
    expect(prepared).toMatchObject({
      kind: 'available',
      prepared: { offer: { annualEstimateYen: 15_360 } },
    });
    if (prepared.kind !== 'available')
      throw new Error('missing prepared offer');
    expect(
      contractOfferHashDecoder.decode(prepared.prepared.offerHash).ok,
    ).toBe(true);
    const command = contractCommand({
      presentedOfferHash: prepared.prepared.offerHash,
    });
    const input = {
      context: billingContext(),
      disclosure: contractDisclosure(),
      command,
      evidenceId: contractIds.evidenceA,
      confirmedAt: 1_000,
    } as const;
    const recorded = await service.confirm(input);
    expect(recorded).toMatchObject({ kind: 'accepted', outcome: 'recorded' });
    expect(await service.confirm(input)).toEqual(
      recorded.kind === 'accepted'
        ? { ...recorded, outcome: 'replayed' }
        : recorded,
    );
    expect(
      await repository.findBySubmission(
        billingContext('b'),
        command.submissionId,
      ),
    ).toBeUndefined();
  });

  it('fails before persistence for stale or unconfirmed client state', async () => {
    const append = vi.fn<ContractEvidenceRepository['append']>();
    const service = createContractEvidenceService({
      repository: {
        findBySubmission: async () => undefined,
        append,
      },
      hasher: fixedHasher(contractIds.offerHashA),
    });
    await expect(
      service.confirm({
        context: billingContext(),
        disclosure: contractDisclosure(),
        command: contractCommand({
          presentedOfferHash: contractIds.offerHashB,
        }),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'stale-offer' });
    await expect(
      service.confirm({
        context: billingContext(),
        disclosure: contractDisclosure(),
        command: contractCommand({ consent: { kind: 'not-affirmed' } }),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'consent-required' });
    expect(append).not.toHaveBeenCalled();
  });

  it('fails closed for invalid hash output and repository failures', async () => {
    const rejectingRepository: ContractEvidenceRepository = {
      findBySubmission: async () => {
        throw new Error('D1 unavailable');
      },
      append: async () => ({ kind: 'created' }),
    };
    await expect(
      createContractEvidenceService({
        repository: createFakeContractEvidenceRepository(),
        hasher: { hash: async () => 'not-a-hash' },
      }).prepareOffer(contractDisclosure()),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'hash-unavailable' });
    await expect(
      createContractEvidenceService({
        repository: rejectingRepository,
        hasher: fixedHasher(contractIds.offerHashA),
      }).confirm({
        context: billingContext(),
        disclosure: contractDisclosure(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
  });

  it('revalidates an insert race and rejects an evidence identifier collision', async () => {
    const existing = contractEvidence();
    const raced = createContractEvidenceService({
      repository: {
        findBySubmission: async () => undefined,
        append: async () => ({ kind: 'existing', record: existing }),
      },
      hasher: fixedHasher(contractIds.offerHashA),
    });
    await expect(
      raced.confirm({
        context: billingContext(),
        disclosure: contractDisclosure(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceB,
        confirmedAt: 2_000,
      }),
    ).resolves.toMatchObject({ kind: 'accepted', outcome: 'replayed' });

    const conflicted = createContractEvidenceService({
      repository: {
        findBySubmission: async () => undefined,
        append: async () => ({ kind: 'conflict' }),
      },
      hasher: fixedHasher(contractIds.offerHashA),
    });
    await expect(
      conflicted.confirm({
        context: billingContext(),
        disclosure: contractDisclosure(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'identifier-conflict',
    });
  });
});

function fixedHasher(hash: string): ContractOfferHasherPort {
  return { hash: async () => hash };
}
