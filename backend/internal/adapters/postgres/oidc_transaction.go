package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidOidcTransactionOperation = errors.New("invalid OIDC transaction operation")
	ErrInvalidStoredOidcTransaction    = errors.New("invalid stored OIDC transaction")
	ErrOidcTransactionConflict         = errors.New("OIDC transaction conflict")
)

type OidcTransactionStore struct {
	pool *pgxpool.Pool
}

var _ identity.OidcTransactionStore = (*OidcTransactionStore)(nil)

const oidcTransactionColumns = `state, nonce, code_verifier, redirect_uri,
       purpose, purpose_account_id, signup_submission_id, signup_terms_version,
       signup_terms_hash, signup_affirmed, created_at_seconds, expires_at_seconds`

func NewOidcTransactionStore(pool *pgxpool.Pool) (*OidcTransactionStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &OidcTransactionStore{pool: pool}, nil
}

func (store *OidcTransactionStore) InsertPending(
	ctx context.Context,
	transaction identity.PendingOidcTransaction,
) error {
	if store == nil || store.pool == nil || ctx == nil ||
		!identity.ValidPendingOidcTransaction(transaction) {
		return ErrInvalidOidcTransactionOperation
	}
	purposeAccountID, submissionID, termsVersion, termsHash, affirmed :=
		oidcTransactionOptionalBindings(transaction)
	_, err := store.pool.Exec(
		ctx,
		`INSERT INTO oidc_login_transactions(`+oidcTransactionColumns+`)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		string(transaction.State), string(transaction.Nonce), string(transaction.CodeVerifier),
		string(transaction.RedirectURI), string(transaction.Purpose.Kind), purposeAccountID,
		submissionID, termsVersion, termsHash, affirmed,
		transaction.CreatedAtEpochSeconds, transaction.ExpiresAtEpochSeconds,
	)
	if isOidcTransactionConflict(err) {
		return ErrOidcTransactionConflict
	}
	if err != nil {
		return ErrInvalidOidcTransactionOperation
	}
	return nil
}

func (store *OidcTransactionStore) ConsumeByState(
	ctx context.Context,
	state identity.OidcState,
) (*identity.PendingOidcTransaction, error) {
	if store == nil || store.pool == nil || ctx == nil {
		return nil, ErrInvalidOidcTransactionOperation
	}
	parsed, err := identity.ParseOidcState(string(state))
	if err != nil || parsed != state {
		return nil, ErrInvalidOidcTransactionOperation
	}
	transaction, err := scanOidcTransaction(store.pool.QueryRow(
		ctx,
		`DELETE FROM oidc_login_transactions WHERE state = $1
		 RETURNING `+oidcTransactionColumns,
		string(state),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &transaction, nil
}

func scanOidcTransaction(row rowScanner) (identity.PendingOidcTransaction, error) {
	var rawState, rawNonce, rawVerifier, rawRedirect, rawPurpose string
	var rawPurposeAccountID, submissionID, termsVersion, termsHash pgtype.Text
	var affirmed pgtype.Bool
	var createdAt, expiresAt int64
	if err := row.Scan(
		&rawState, &rawNonce, &rawVerifier, &rawRedirect, &rawPurpose,
		&rawPurposeAccountID, &submissionID, &termsVersion, &termsHash, &affirmed,
		&createdAt, &expiresAt,
	); err != nil {
		return identity.PendingOidcTransaction{}, err
	}
	state, stateErr := identity.ParseOidcState(rawState)
	nonce, nonceErr := identity.ParseOidcNonce(rawNonce)
	verifier, verifierErr := identity.ParsePkceCodeVerifier(rawVerifier)
	redirect, redirectErr := identity.ParseOidcRedirectURI(rawRedirect)
	purpose := identity.OidcPurpose{Kind: identity.OidcPurposeKind(rawPurpose)}
	if rawPurposeAccountID.Valid {
		accountID, accountErr := identity.ParseAccountID(rawPurposeAccountID.String)
		if accountErr != nil {
			return identity.PendingOidcTransaction{}, ErrInvalidStoredOidcTransaction
		}
		purpose.AccountID = accountID
	}
	var consent *identity.SignupTermsConsent
	optionalCount := 0
	for _, valid := range []bool{submissionID.Valid, termsVersion.Valid, termsHash.Valid, affirmed.Valid} {
		if valid {
			optionalCount++
		}
	}
	if optionalCount != 0 && optionalCount != 4 {
		return identity.PendingOidcTransaction{}, ErrInvalidStoredOidcTransaction
	}
	if optionalCount == 4 {
		consent = &identity.SignupTermsConsent{
			SubmissionID: submissionID.String, PresentedTermsVersion: termsVersion.String,
			PresentedTermsHash: termsHash.String, Affirmed: affirmed.Bool,
		}
	}
	transaction := identity.PendingOidcTransaction{
		State: state, Nonce: nonce, CodeVerifier: verifier, RedirectURI: redirect,
		Purpose: purpose, SignupTermsConsent: consent,
		CreatedAtEpochSeconds: createdAt, ExpiresAtEpochSeconds: expiresAt,
	}
	if stateErr != nil || nonceErr != nil || verifierErr != nil || redirectErr != nil ||
		!identity.ValidPendingOidcTransaction(transaction) {
		return identity.PendingOidcTransaction{}, ErrInvalidStoredOidcTransaction
	}
	return transaction, nil
}

func oidcTransactionOptionalBindings(
	transaction identity.PendingOidcTransaction,
) (any, any, any, any, any) {
	var purposeAccountID any
	if transaction.Purpose.Kind == identity.OidcPurposeLink {
		purposeAccountID = string(transaction.Purpose.AccountID)
	}
	if transaction.SignupTermsConsent == nil {
		return purposeAccountID, nil, nil, nil, nil
	}
	consent := transaction.SignupTermsConsent
	return purposeAccountID, consent.SubmissionID, consent.PresentedTermsVersion,
		consent.PresentedTermsHash, consent.Affirmed
}

func isOidcTransactionConflict(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}
