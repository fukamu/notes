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
	ErrInvalidTermsConsentOperation = errors.New("invalid terms consent operation")
	ErrInvalidTermsConsentRecord    = errors.New("invalid stored terms consent record")
)

type TermsConsentStore struct {
	pool *pgxpool.Pool
}

var _ legal.TermsConsentRepository = (*TermsConsentStore)(nil)

const termsConsentSelect = `SELECT account_id, vault_id, consent_id,
       submission_id, terms_version, terms_hash, serialized_terms,
       consent, accepted_at
  FROM terms_consent_evidence`

func NewTermsConsentStore(pool *pgxpool.Pool) (*TermsConsentStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &TermsConsentStore{pool: pool}, nil
}

func (store *TermsConsentStore) FindByID(
	ctx context.Context,
	scope legal.TermsScope,
	consentID legal.TermsConsentID,
) (*legal.TermsConsentRecord, error) {
	if store == nil || store.pool == nil || !legal.ValidTermsScope(scope) {
		return nil, ErrInvalidTermsConsentOperation
	}
	if _, err := legal.ParseTermsConsentID(string(consentID)); err != nil {
		return nil, ErrInvalidTermsConsentOperation
	}
	return scanOptionalTermsConsent(store.pool.QueryRow(
		ctx,
		termsConsentSelect+" WHERE account_id = $1 AND vault_id = $2 AND consent_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(consentID),
	))
}

func (store *TermsConsentStore) FindBySubmission(
	ctx context.Context,
	scope legal.TermsScope,
	submissionID legal.TermsConsentSubmissionID,
) (*legal.TermsConsentRecord, error) {
	if store == nil || store.pool == nil || !legal.ValidTermsScope(scope) {
		return nil, ErrInvalidTermsConsentOperation
	}
	if _, err := legal.ParseTermsConsentSubmissionID(string(submissionID)); err != nil {
		return nil, ErrInvalidTermsConsentOperation
	}
	return scanOptionalTermsConsent(store.pool.QueryRow(
		ctx,
		termsConsentSelect+" WHERE account_id = $1 AND vault_id = $2 AND submission_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(submissionID),
	))
}

func (store *TermsConsentStore) FindLatest(
	ctx context.Context,
	scope legal.TermsScope,
) (*legal.TermsConsentRecord, error) {
	if store == nil || store.pool == nil || !legal.ValidTermsScope(scope) {
		return nil, ErrInvalidTermsConsentOperation
	}
	return scanOptionalTermsConsent(store.pool.QueryRow(
		ctx,
		termsConsentSelect+` WHERE account_id = $1 AND vault_id = $2
         ORDER BY accepted_at DESC, consent_id DESC LIMIT 1`,
		string(scope.AccountID), string(scope.VaultID),
	))
}

func (store *TermsConsentStore) Append(
	ctx context.Context,
	record legal.TermsConsentRecord,
) (legal.TermsAppendResult, error) {
	if store == nil || store.pool == nil || !legal.ValidTermsConsentRecord(record) {
		return legal.TermsAppendResult{}, ErrInvalidTermsConsentOperation
	}
	result := legal.TermsAppendResult{Kind: legal.TermsAppendConflict}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		authorized, authorizeErr := termsConsentScopeAuthorized(ctx, transaction, record)
		if authorizeErr != nil {
			return authorizeErr
		}
		if !authorized {
			result.Kind = legal.TermsAppendOwnerMismatch
			return nil
		}
		tag, insertErr := transaction.Exec(
			ctx,
			`INSERT INTO terms_consent_evidence(
			 account_id, vault_id, consent_id, submission_id, terms_version,
			 terms_hash, serialized_terms, consent, accepted_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, 'affirmed', $8)
			ON CONFLICT DO NOTHING`,
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.ConsentID),
			string(record.SubmissionID), string(record.Snapshot.TermsVersion), string(record.Snapshot.TermsHash),
			record.Snapshot.SerializedTerms, record.AcceptedAt,
		)
		if insertErr != nil {
			return insertErr
		}
		if tag.RowsAffected() == 1 {
			result.Kind = legal.TermsAppendCreated
			return nil
		}
		existing, findErr := scanOptionalTermsConsent(transaction.QueryRow(
			ctx,
			termsConsentSelect+" WHERE account_id = $1 AND vault_id = $2 AND submission_id = $3 FOR SHARE",
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.SubmissionID),
		))
		if findErr != nil {
			return findErr
		}
		if existing != nil {
			result = legal.TermsAppendResult{Kind: legal.TermsAppendExisting, Record: existing}
			return nil
		}
		byID, findErr := scanOptionalTermsConsent(transaction.QueryRow(
			ctx,
			termsConsentSelect+" WHERE account_id = $1 AND vault_id = $2 AND consent_id = $3 FOR SHARE",
			string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.ConsentID),
		))
		if findErr != nil {
			return findErr
		}
		if byID != nil {
			result.Kind = legal.TermsAppendConflict
			return nil
		}
		return errors.New("terms consent conflict could not be resolved")
	})
	if isRetryableTransactionError(err) {
		existing, findErr := store.FindBySubmission(ctx, record.Scope, record.SubmissionID)
		if findErr != nil {
			return legal.TermsAppendResult{}, classifyTermsConsentWriteError(findErr)
		}
		if existing != nil {
			return legal.TermsAppendResult{Kind: legal.TermsAppendExisting, Record: existing}, nil
		}
		return legal.TermsAppendResult{Kind: legal.TermsAppendConflict}, nil
	}
	if isTermsOwnerViolation(err) {
		return legal.TermsAppendResult{Kind: legal.TermsAppendOwnerMismatch}, nil
	}
	return result, classifyTermsConsentWriteError(err)
}

func termsConsentScopeAuthorized(
	ctx context.Context,
	transaction pgx.Tx,
	record legal.TermsConsentRecord,
) (bool, error) {
	var authorized bool
	err := transaction.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults
		    WHERE account_id = $1 AND vault_id = $2
		 ) OR EXISTS(
		   SELECT 1 FROM signup_admission_reservations
		    WHERE submission_id = $3 AND account_id = $1 AND vault_id = $2
		 )`,
		string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.SubmissionID),
	).Scan(&authorized)
	return authorized, err
}

func scanOptionalTermsConsent(row rowScanner) (*legal.TermsConsentRecord, error) {
	record, err := scanTermsConsent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanTermsConsent(row rowScanner) (legal.TermsConsentRecord, error) {
	var accountID, vaultID, consentID, submissionID, termsVersion, termsHash, serialized, consent string
	var acceptedAt int64
	if err := row.Scan(
		&accountID, &vaultID, &consentID, &submissionID, &termsVersion,
		&termsHash, &serialized, &consent, &acceptedAt,
	); err != nil {
		return legal.TermsConsentRecord{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedConsentID, consentIDErr := legal.ParseTermsConsentID(consentID)
	parsedSubmissionID, submissionErr := legal.ParseTermsConsentSubmissionID(submissionID)
	parsedVersion, versionErr := legal.ParseTermsVersion(termsVersion)
	parsedHash, hashErr := legal.ParseTermsDocumentHash(termsHash)
	disclosure, disclosureErr := legal.DecodeTermsDisclosure([]byte(serialized))
	record := legal.TermsConsentRecord{
		Scope:     legal.TermsScope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		ConsentID: parsedConsentID, SubmissionID: parsedSubmissionID,
		Snapshot: legal.TermsSnapshot{
			TermsVersion: parsedVersion, TermsHash: parsedHash,
			Disclosure: disclosure, SerializedTerms: serialized,
		},
		Consent: legal.ConsentChoice(consent), AcceptedAt: acceptedAt,
	}
	if accountErr != nil || vaultErr != nil || consentIDErr != nil || submissionErr != nil || versionErr != nil ||
		hashErr != nil || disclosureErr != nil || !legal.ValidTermsConsentRecord(record) {
		return legal.TermsConsentRecord{}, ErrInvalidTermsConsentRecord
	}
	return record, nil
}

func isTermsOwnerViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23503" &&
		postgresError.ConstraintName == "terms_consent_owner_or_reservation"
}

func classifyTermsConsentWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrInvalidTermsConsentOperation
		case "23514", "22003":
			return ErrInvalidTermsConsentRecord
		}
	}
	return err
}
