import type {
  ContractEvidenceAppendResult,
  ContractEvidenceRecord,
  ContractEvidenceRepository,
  ContractEvidenceScope,
  ContractSubmissionId,
} from './public';

export function createFakeContractEvidenceRepository(): ContractEvidenceRepository {
  const bySubmission = new Map<string, ContractEvidenceRecord>();
  const byEvidence = new Map<string, ContractEvidenceRecord>();
  return {
    async findBySubmission(context, submissionId) {
      return bySubmission.get(key(context, submissionId));
    },
    async append(record): Promise<ContractEvidenceAppendResult> {
      const submissionKey = key(record.scope, record.submissionId);
      const existing = bySubmission.get(submissionKey);
      if (existing !== undefined) {
        return { kind: 'existing', record: existing };
      }
      const evidenceKey = key(record.scope, record.evidenceId);
      if (byEvidence.has(evidenceKey)) return { kind: 'conflict' };
      bySubmission.set(submissionKey, record);
      byEvidence.set(evidenceKey, record);
      return { kind: 'created' };
    },
  };
}

function key(
  scope: ContractEvidenceScope,
  identifier: ContractSubmissionId | ContractEvidenceRecord['evidenceId'],
): string {
  return `${scope.accountId}:${scope.vaultId}:${identifier}`;
}
