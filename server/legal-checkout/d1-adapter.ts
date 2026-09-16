import { decodeOrThrow } from '../../lib/codec/core';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import { contractEvidenceRowDecoder, mapContractEvidenceRow } from './records';
import type {
  ContractEvidenceAppendResult,
  ContractEvidenceId,
  ContractEvidenceRecord,
  ContractEvidenceRepository,
  ContractSubmissionId,
} from './public';

const evidenceColumns = `account_id, vault_id, evidence_id, submission_id,
  offer_hash, offer_version, disclosure_version, serialized_offer, consent,
  confirmed_at`;

export class D1ContractEvidenceRepository implements ContractEvidenceRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  findBySubmission(
    context: VaultContext,
    submissionId: ContractSubmissionId,
  ): Promise<ContractEvidenceRecord | undefined> {
    return this.findBySubmissionScope(
      context.accountId,
      context.vaultId,
      submissionId,
    );
  }

  async append(
    record: ContractEvidenceRecord,
  ): Promise<ContractEvidenceAppendResult> {
    try {
      const result = await this.database
        .prepare(
          `INSERT INTO contract_evidence(${evidenceColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.scope.accountId,
          record.scope.vaultId,
          record.evidenceId,
          record.submissionId,
          record.offerHash,
          record.offer.offerVersion,
          record.offer.disclosureVersion,
          record.serializedOffer,
          record.consent,
          record.confirmedAt,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error('contract evidence insert did not change one row');
      }
      return { kind: 'created' };
    } catch (error: unknown) {
      const [submission, evidence] = await Promise.all([
        this.findBySubmissionScope(
          record.scope.accountId,
          record.scope.vaultId,
          record.submissionId,
        ),
        this.findByEvidenceScope(
          record.scope.accountId,
          record.scope.vaultId,
          record.evidenceId,
        ),
      ]);
      if (submission !== undefined) {
        return { kind: 'existing', record: submission };
      }
      if (evidence !== undefined) return { kind: 'conflict' };
      throw error;
    }
  }

  private async findBySubmissionScope(
    accountId: AccountId,
    vaultId: VaultId,
    submissionId: ContractSubmissionId,
  ): Promise<ContractEvidenceRecord | undefined> {
    return this.readOne(
      `SELECT ${evidenceColumns} FROM contract_evidence
       WHERE account_id = ? AND vault_id = ? AND submission_id = ?`,
      [accountId, vaultId, submissionId],
    );
  }

  private async findByEvidenceScope(
    accountId: AccountId,
    vaultId: VaultId,
    evidenceId: ContractEvidenceId,
  ): Promise<ContractEvidenceRecord | undefined> {
    return this.readOne(
      `SELECT ${evidenceColumns} FROM contract_evidence
       WHERE account_id = ? AND vault_id = ? AND evidence_id = ?`,
      [accountId, vaultId, evidenceId],
    );
  }

  private async readOne(
    sql: string,
    bindings: readonly [string, string, string],
  ): Promise<ContractEvidenceRecord | undefined> {
    const candidate: unknown = await this.database
      .prepare(sql)
      .bind(...bindings)
      .first();
    return candidate === null
      ? undefined
      : mapContractEvidenceRow(
          decodeOrThrow(
            contractEvidenceRowDecoder,
            candidate,
            'D1 contract evidence row',
          ),
        );
  }
}
