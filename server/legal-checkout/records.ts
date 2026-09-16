import {
  BoundaryDecodeError,
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import { serializeContractOffer } from './core';
import {
  contractEvidenceIdDecoder,
  contractOfferHashDecoder,
  contractOfferSnapshotDecoder,
  contractSubmissionIdDecoder,
  type ContractEvidenceRecord,
} from './public';

export const contractEvidenceRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  evidence_id: contractEvidenceIdDecoder,
  submission_id: contractSubmissionIdDecoder,
  offer_hash: contractOfferHashDecoder,
  offer_version: stringDecoder({ minLength: 1, maxLength: 128 }),
  disclosure_version: stringDecoder({ minLength: 10, maxLength: 10 }),
  serialized_offer: stringDecoder({ minLength: 1, maxLength: 8_192 }),
  consent: literalDecoder('affirmed'),
  confirmed_at: safeIntegerDecoder({ minimum: 0 }),
});

export type ContractEvidenceRow = InferDecoder<
  typeof contractEvidenceRowDecoder
>;

export function mapContractEvidenceRow(
  row: ContractEvidenceRow,
): ContractEvidenceRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.serialized_offer);
  } catch {
    invalidRow('serialized offer is not JSON');
  }
  const decoded = contractOfferSnapshotDecoder.decode(candidate);
  if (!decoded.ok) {
    throw new BoundaryDecodeError('D1 contract evidence offer', decoded.issues);
  }
  if (
    serializeContractOffer(decoded.value) !== row.serialized_offer ||
    decoded.value.offerVersion !== row.offer_version ||
    decoded.value.disclosureVersion !== row.disclosure_version
  ) {
    invalidRow('stored offer metadata is inconsistent');
  }
  return {
    scope: { accountId: row.account_id, vaultId: row.vault_id },
    evidenceId: row.evidence_id,
    submissionId: row.submission_id,
    offerHash: row.offer_hash,
    offer: decoded.value,
    serializedOffer: row.serialized_offer,
    consent: row.consent,
    confirmedAt: row.confirmed_at,
  };
}

function invalidRow(reason: string): never {
  throw new BoundaryDecodeError('D1 contract evidence row', [
    { path: [], reason },
  ]);
}
