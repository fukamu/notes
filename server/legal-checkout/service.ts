import { contractOfferHashDecoder } from './public';
import {
  planContractEvidence,
  planContractOffer,
  serializeContractOffer,
} from './core';
import type {
  ContractConfirmationResult,
  ContractEvidenceAppendResult,
  ContractEvidenceService,
  ContractOfferHasherPort,
  ContractEvidenceRepository,
  PrepareContractOfferResult,
  PreparedContractOffer,
} from './public';

export function createContractEvidenceService(dependencies: {
  readonly repository: ContractEvidenceRepository;
  readonly hasher: ContractOfferHasherPort;
}): ContractEvidenceService {
  async function prepareOffer(
    disclosure: unknown,
  ): Promise<PrepareContractOfferResult> {
    const plan = planContractOffer(disclosure);
    if (plan.kind === 'rejected') {
      return { kind: 'unavailable', reason: plan.reason };
    }
    const serializedOffer = serializeContractOffer(plan.offer);
    let candidate: unknown;
    try {
      candidate = await dependencies.hasher.hash(serializedOffer);
    } catch {
      return { kind: 'unavailable', reason: 'hash-unavailable' };
    }
    const decoded = contractOfferHashDecoder.decode(candidate);
    return decoded.ok
      ? {
          kind: 'available',
          prepared: {
            offer: plan.offer,
            serializedOffer,
            offerHash: decoded.value,
          },
        }
      : { kind: 'unavailable', reason: 'hash-unavailable' };
  }

  return {
    prepareOffer,
    async confirm(input): Promise<ContractConfirmationResult> {
      const prepared = await prepareOffer(input.disclosure);
      if (prepared.kind === 'unavailable') {
        return { kind: 'rejected', reason: prepared.reason };
      }
      let existing;
      try {
        existing = await dependencies.repository.findBySubmission(
          input.context,
          input.command.submissionId,
        );
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
      const plan = evidencePlan(input, prepared.prepared, existing);
      if (plan.kind === 'rejected') return plan;
      if (plan.kind === 'replay') {
        return {
          kind: 'accepted',
          outcome: 'replayed',
          evidence: plan.record,
        };
      }

      let appended: ContractEvidenceAppendResult;
      try {
        appended = await dependencies.repository.append(plan.record);
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
      switch (appended.kind) {
        case 'created':
          return {
            kind: 'accepted',
            outcome: 'recorded',
            evidence: plan.record,
          };
        case 'conflict':
          return { kind: 'rejected', reason: 'identifier-conflict' };
        case 'existing': {
          const raced = evidencePlan(input, prepared.prepared, appended.record);
          return raced.kind === 'replay'
            ? {
                kind: 'accepted',
                outcome: 'replayed',
                evidence: raced.record,
              }
            : raced.kind === 'rejected'
              ? raced
              : { kind: 'rejected', reason: 'identifier-conflict' };
        }
      }
    },
  };
}

function evidencePlan(
  input: Parameters<ContractEvidenceService['confirm']>[0],
  prepared: PreparedContractOffer,
  existing: Awaited<ReturnType<ContractEvidenceRepository['findBySubmission']>>,
) {
  return planContractEvidence({
    context: input.context,
    command: input.command,
    offer: prepared.offer,
    serializedOffer: prepared.serializedOffer,
    authoritativeOfferHash: prepared.offerHash,
    evidenceId: input.evidenceId,
    confirmedAt: input.confirmedAt,
    existing,
  });
}
