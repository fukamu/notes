package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidContractEvidenceOperation = errors.New("invalid contract evidence operation")
	ErrInvalidContractEvidenceRecord    = errors.New("invalid stored contract evidence record")
)

type ContractEvidenceStore struct {
	pool *pgxpool.Pool
}

var _ legal.ContractEvidenceRepository = (*ContractEvidenceStore)(nil)

const contractEvidenceSelect = `SELECT account_id, vault_id, evidence_id, submission_id,
       offer_hash, offer_version, disclosure_version, serialized_offer,
       consent, confirmed_at
  FROM contract_evidence`

func NewContractEvidenceStore(pool *pgxpool.Pool) (*ContractEvidenceStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &ContractEvidenceStore{pool: pool}, nil
}

func (store *ContractEvidenceStore) FindBySubmission(
	ctx context.Context,
	scope legal.TermsScope,
	submissionID legal.ContractSubmissionID,
) (*legal.ContractEvidenceRecord, error) {
	if store == nil || store.pool == nil || !legal.ValidTermsScope(scope) {
		return nil, ErrInvalidContractEvidenceOperation
	}
	if _, err := legal.ParseContractSubmissionID(string(submissionID)); err != nil {
		return nil, ErrInvalidContractEvidenceOperation
	}
	return scanOptionalContractEvidence(store.pool.QueryRow(
		ctx,
		contractEvidenceSelect+" WHERE account_id = $1 AND vault_id = $2 AND submission_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(submissionID),
	))
}

func (store *ContractEvidenceStore) Append(
	ctx context.Context,
	record legal.ContractEvidenceRecord,
) (legal.ContractEvidenceAppendResult, error) {
	if store == nil || store.pool == nil || !legal.ValidContractEvidenceRecord(record) {
		return legal.ContractEvidenceAppendResult{}, ErrInvalidContractEvidenceOperation
	}
	result := legal.ContractEvidenceAppendResult{Kind: legal.ContractEvidenceAppendConflict}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		var owned bool
		if err := transaction.QueryRow(
			ctx,
			`SELECT EXISTS(
			   SELECT 1 FROM personal_vaults
			    WHERE account_id = $1 AND vault_id = $2
			 )`,
			string(record.Scope.AccountID), string(record.Scope.VaultID),
		).Scan(&owned); err != nil {
			return err
		}
		if !owned {
			result.Kind = legal.ContractEvidenceAppendOwnerMismatch
			return nil
		}
		tag, err := transaction.Exec(
			ctx,
			`INSERT INTO contract_evidence(
			 account_id, vault_id, evidence_id, submission_id, offer_hash,
			 offer_version, disclosure_version, serialized_offer, consent, confirmed_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'affirmed', $9)
			ON CONFLICT DO NOTHING`,
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.EvidenceID),
			string(record.SubmissionID), string(record.OfferHash), record.Offer.OfferVersion,
			record.Offer.DisclosureVersion, record.SerializedOffer, record.ConfirmedAt,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			result.Kind = legal.ContractEvidenceAppendCreated
			return nil
		}
		existing, err := scanOptionalContractEvidence(transaction.QueryRow(
			ctx,
			contractEvidenceSelect+" WHERE account_id = $1 AND vault_id = $2 AND submission_id = $3 FOR SHARE",
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.SubmissionID),
		))
		if err != nil {
			return err
		}
		if existing != nil {
			result = legal.ContractEvidenceAppendResult{Kind: legal.ContractEvidenceAppendExisting, Record: existing}
			return nil
		}
		byID, err := scanOptionalContractEvidence(transaction.QueryRow(
			ctx,
			contractEvidenceSelect+" WHERE account_id = $1 AND vault_id = $2 AND evidence_id = $3 FOR SHARE",
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.EvidenceID),
		))
		if err != nil {
			return err
		}
		if byID != nil {
			result.Kind = legal.ContractEvidenceAppendConflict
			return nil
		}
		return errors.New("contract evidence conflict could not be resolved")
	})
	if isRetryableTransactionError(err) {
		existing, findErr := store.FindBySubmission(ctx, record.Scope, record.SubmissionID)
		if findErr != nil {
			return legal.ContractEvidenceAppendResult{}, classifyContractEvidenceWriteError(findErr)
		}
		if existing != nil {
			return legal.ContractEvidenceAppendResult{Kind: legal.ContractEvidenceAppendExisting, Record: existing}, nil
		}
		return legal.ContractEvidenceAppendResult{Kind: legal.ContractEvidenceAppendConflict}, nil
	}
	if isContractEvidenceOwnerViolation(err) {
		return legal.ContractEvidenceAppendResult{Kind: legal.ContractEvidenceAppendOwnerMismatch}, nil
	}
	return result, classifyContractEvidenceWriteError(err)
}

func scanOptionalContractEvidence(row rowScanner) (*legal.ContractEvidenceRecord, error) {
	record, err := scanContractEvidence(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanContractEvidence(row rowScanner) (legal.ContractEvidenceRecord, error) {
	var accountID, vaultID, evidenceID, submissionID, offerHash string
	var offerVersion, disclosureVersion, serialized, consent string
	var confirmedAt int64
	if err := row.Scan(
		&accountID, &vaultID, &evidenceID, &submissionID, &offerHash,
		&offerVersion, &disclosureVersion, &serialized, &consent, &confirmedAt,
	); err != nil {
		return legal.ContractEvidenceRecord{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedEvidenceID, evidenceErr := legal.ParseContractEvidenceID(evidenceID)
	parsedSubmissionID, submissionErr := legal.ParseContractSubmissionID(submissionID)
	parsedHash, hashErr := legal.ParseContractOfferHash(offerHash)
	offer, offerErr := legal.DecodeContractOffer([]byte(serialized))
	record := legal.ContractEvidenceRecord{
		Scope:      legal.TermsScope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		EvidenceID: parsedEvidenceID, SubmissionID: parsedSubmissionID, OfferHash: parsedHash,
		Offer: offer, SerializedOffer: serialized, Consent: legal.ContractConsent(consent), ConfirmedAt: confirmedAt,
	}
	if accountErr != nil || vaultErr != nil || evidenceErr != nil || submissionErr != nil || hashErr != nil ||
		offerErr != nil || offer.OfferVersion != offerVersion || offer.DisclosureVersion != disclosureVersion ||
		!legal.ValidContractEvidenceRecord(record) {
		return legal.ContractEvidenceRecord{}, ErrInvalidContractEvidenceRecord
	}
	return record, nil
}

func isContractEvidenceOwnerViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23503" &&
		postgresError.ConstraintName == "contract_evidence_owner_fk"
}

func classifyContractEvidenceWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrInvalidContractEvidenceOperation
		case "23514", "22003":
			return ErrInvalidContractEvidenceRecord
		}
	}
	return err
}
