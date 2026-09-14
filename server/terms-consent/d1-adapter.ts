import { decodeOrThrow } from '../../lib/codec/core';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import { termsConsentRecordMatchesContext } from './core';
import { mapTermsConsentRow, termsConsentRowDecoder } from './records';
import type {
  TermsConsentAppendResult,
  TermsConsentId,
  TermsConsentRecord,
  TermsConsentRepository,
  TermsConsentSubmissionId,
} from './public';

const consentColumns = `account_id, vault_id, consent_id, submission_id,
  terms_version, terms_hash, serialized_terms, consent, accepted_at`;

export class D1TermsConsentRepository implements TermsConsentRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  findById(
    context: VaultContext,
    consentId: TermsConsentId,
  ): Promise<TermsConsentRecord | undefined> {
    return this.findByIdScope(context.accountId, context.vaultId, consentId);
  }

  findBySubmission(
    context: VaultContext,
    submissionId: TermsConsentSubmissionId,
  ): Promise<TermsConsentRecord | undefined> {
    return this.findBySubmissionScope(
      context.accountId,
      context.vaultId,
      submissionId,
    );
  }

  findLatest(context: VaultContext): Promise<TermsConsentRecord | undefined> {
    return this.readOne(
      `SELECT ${consentColumns} FROM terms_consent_evidence
       WHERE account_id = ? AND vault_id = ?
       ORDER BY accepted_at DESC, consent_id DESC LIMIT 1`,
      [context.accountId, context.vaultId],
    );
  }

  async append(
    context: VaultContext,
    record: TermsConsentRecord,
  ): Promise<TermsConsentAppendResult> {
    if (!termsConsentRecordMatchesContext(record, context)) {
      return { kind: 'rejected', reason: 'owner-mismatch' };
    }
    try {
      const result = await this.database
        .prepare(
          `INSERT INTO terms_consent_evidence(${consentColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.scope.accountId,
          record.scope.vaultId,
          record.consentId,
          record.submissionId,
          record.snapshot.termsVersion,
          record.snapshot.termsHash,
          record.snapshot.serializedTerms,
          record.consent,
          record.acceptedAt,
        )
        .run();
      if (result.meta.changes !== 1) {
        throw new Error('terms consent insert did not change one row');
      }
      return { kind: 'created' };
    } catch (error: unknown) {
      const [submission, consent] = await Promise.all([
        this.findBySubmissionScope(
          record.scope.accountId,
          record.scope.vaultId,
          record.submissionId,
        ),
        this.findByIdScope(
          record.scope.accountId,
          record.scope.vaultId,
          record.consentId,
        ),
      ]);
      if (submission !== undefined) {
        return { kind: 'existing', record: submission };
      }
      if (consent !== undefined) return { kind: 'conflict' };
      throw error;
    }
  }

  private findByIdScope(
    accountId: AccountId,
    vaultId: VaultId,
    consentId: TermsConsentId,
  ): Promise<TermsConsentRecord | undefined> {
    return this.readOne(
      `SELECT ${consentColumns} FROM terms_consent_evidence
       WHERE account_id = ? AND vault_id = ? AND consent_id = ?`,
      [accountId, vaultId, consentId],
    );
  }

  private findBySubmissionScope(
    accountId: AccountId,
    vaultId: VaultId,
    submissionId: TermsConsentSubmissionId,
  ): Promise<TermsConsentRecord | undefined> {
    return this.readOne(
      `SELECT ${consentColumns} FROM terms_consent_evidence
       WHERE account_id = ? AND vault_id = ? AND submission_id = ?`,
      [accountId, vaultId, submissionId],
    );
  }

  private async readOne(
    sql: string,
    bindings: readonly string[],
  ): Promise<TermsConsentRecord | undefined> {
    const candidate: unknown = await this.database
      .prepare(sql)
      .bind(...bindings)
      .first();
    return candidate === null
      ? undefined
      : mapTermsConsentRow(
          decodeOrThrow(
            termsConsentRowDecoder,
            candidate,
            'D1 terms consent row',
          ),
        );
  }
}
