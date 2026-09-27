package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidIdentityOperation = errors.New("invalid identity operation")
	ErrInvalidIdentityRecord    = errors.New("invalid stored identity record")
	ErrInvalidSignupOperation   = errors.New("invalid signup operation")
	errSignupConflict           = errors.New("signup provisioning conflict")
)

type IdentityStore struct {
	pool *pgxpool.Pool
}

var (
	_ identity.OidcIdentityDirectory     = (*IdentityStore)(nil)
	_ identity.EmailOtpIdentityDirectory = (*IdentityStore)(nil)
)

func NewIdentityStore(pool *pgxpool.Pool) (*IdentityStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &IdentityStore{pool: pool}, nil
}

func (store *IdentityStore) FindByIssuerSubject(
	ctx context.Context,
	key identity.OidcIdentityKey,
) (*identity.OidcIdentityRecord, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidIdentityOperation
	}
	if _, err := identity.ParseOidcIssuer(string(key.Issuer)); err != nil {
		return nil, ErrInvalidIdentityOperation
	}
	if _, err := identity.ParseOidcSubject(string(key.Subject)); err != nil {
		return nil, ErrInvalidIdentityOperation
	}
	var rawIdentityID, rawAccountID, rawVaultID, rawIssuer, rawSubject string
	err := store.pool.QueryRow(
		ctx,
		`SELECT identity.identity_id, identity.account_id, vault.vault_id,
		        identity.issuer, identity.subject
		   FROM identities identity
		   JOIN personal_vaults vault ON vault.account_id = identity.account_id
		  WHERE identity.provider = 'google-oidc'
		    AND identity.issuer = $1 AND identity.subject = $2`,
		string(key.Issuer), string(key.Subject),
	).Scan(&rawIdentityID, &rawAccountID, &rawVaultID, &rawIssuer, &rawSubject)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record, err := decodeOidcIdentityRecord(rawIdentityID, rawAccountID, rawVaultID, rawIssuer, rawSubject)
	if err != nil || record.Issuer != key.Issuer || record.Subject != key.Subject {
		return nil, ErrInvalidIdentityRecord
	}
	return &record, nil
}

func (store *IdentityStore) FindByAddress(
	ctx context.Context,
	address identity.EmailOtpAddress,
) (*identity.EmailOtpIdentityRecord, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidIdentityOperation
	}
	parsedAddress, err := identity.ParseEmailOtpAddress(string(address))
	if err != nil || parsedAddress != address {
		return nil, ErrInvalidIdentityOperation
	}
	var rawIdentityID, rawAccountID, rawVaultID, rawSubject string
	err = store.pool.QueryRow(
		ctx,
		`SELECT identity.identity_id, identity.account_id, vault.vault_id, identity.subject
		   FROM identities identity
		   JOIN personal_vaults vault ON vault.account_id = identity.account_id
		  WHERE identity.provider = 'email-otp'
		    AND identity.issuer = 'fukamu.email-otp' AND identity.subject = $1`,
		string(address),
	).Scan(&rawIdentityID, &rawAccountID, &rawVaultID, &rawSubject)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record, err := decodeEmailOtpIdentityRecord(rawIdentityID, rawAccountID, rawVaultID, rawSubject)
	if err != nil || record.Address != address {
		return nil, ErrInvalidIdentityRecord
	}
	return &record, nil
}

func (store *IdentityStore) FindAccountIDByVerifiedEmail(
	ctx context.Context,
	email identity.VerifiedEmailAddress,
) (*identity.AccountID, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidIdentityOperation
	}
	parsedEmail, err := identity.ParseVerifiedEmailAddress(string(email))
	if err != nil || parsedEmail != email {
		return nil, ErrInvalidIdentityOperation
	}
	var rawAccountID string
	err = store.pool.QueryRow(
		ctx,
		"SELECT account_id FROM verified_email_owners WHERE email = $1",
		string(email),
	).Scan(&rawAccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	accountID, err := identity.ParseAccountID(rawAccountID)
	if err != nil {
		return nil, ErrInvalidIdentityRecord
	}
	return &accountID, nil
}

func decodeOidcIdentityRecord(
	rawIdentityID string,
	rawAccountID string,
	rawVaultID string,
	rawIssuer string,
	rawSubject string,
) (identity.OidcIdentityRecord, error) {
	identityID, identityErr := identity.ParseIdentityID(rawIdentityID)
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	issuer, issuerErr := identity.ParseOidcIssuer(rawIssuer)
	subject, subjectErr := identity.ParseOidcSubject(rawSubject)
	if identityErr != nil || accountErr != nil || vaultErr != nil || issuerErr != nil || subjectErr != nil {
		return identity.OidcIdentityRecord{}, ErrInvalidIdentityRecord
	}
	return identity.OidcIdentityRecord{
		IdentityID: identityID, AccountID: accountID, VaultID: vaultID,
		Issuer: issuer, Subject: subject,
	}, nil
}

func decodeEmailOtpIdentityRecord(
	rawIdentityID string,
	rawAccountID string,
	rawVaultID string,
	rawAddress string,
) (identity.EmailOtpIdentityRecord, error) {
	identityID, identityErr := identity.ParseIdentityID(rawIdentityID)
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	address, addressErr := identity.ParseEmailOtpAddress(rawAddress)
	if identityErr != nil || accountErr != nil || vaultErr != nil || addressErr != nil {
		return identity.EmailOtpIdentityRecord{}, ErrInvalidIdentityRecord
	}
	return identity.EmailOtpIdentityRecord{
		IdentityID: identityID, AccountID: accountID, VaultID: vaultID, Address: address,
	}, nil
}

type SignupProvisioningStore struct {
	pool *pgxpool.Pool
}

var _ identity.SignupProvisioningPort = (*SignupProvisioningStore)(nil)

func NewSignupProvisioningStore(pool *pgxpool.Pool) (*SignupProvisioningStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &SignupProvisioningStore{pool: pool}, nil
}

func (store *SignupProvisioningStore) Reserve(
	ctx context.Context,
	candidate identity.SignupAdmissionReservation,
) (identity.SignupReservationResult, error) {
	if store == nil || store.pool == nil || !candidate.Valid() {
		return identity.SignupReservationResult{}, ErrInvalidSignupOperation
	}
	provider, issuer, subject := candidate.Identity.ProviderIdentityKey()
	if provider == "" {
		return identity.SignupReservationResult{}, ErrInvalidSignupOperation
	}
	result := identity.SignupReservationResult{}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		tag, err := transaction.Exec(
			ctx,
			`INSERT INTO signup_admission_reservations(
			   submission_id, identity_kind, provider, issuer, subject, verified_email,
			   account_id, vault_id, identity_id, session_id, session_epoch, created_at,
			   finalized_at, terms_consent_id
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL)
			 ON CONFLICT DO NOTHING`,
			candidate.SubmissionID, string(candidate.Identity.Kind), provider, issuer, subject,
			string(candidate.Identity.VerifiedEmail()), string(candidate.AccountID), string(candidate.VaultID),
			string(candidate.IdentityID), string(candidate.SessionID), int64(candidate.SessionEpoch), candidate.CreatedAt,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			result = identity.SignupReservationResult{Kind: identity.SignupReservationReserved, Reservation: candidate}
			return nil
		}
		stored, _, _, scanErr := scanSignupReservation(transaction.QueryRow(
			ctx, signupReservationSelect+" WHERE submission_id = $1 FOR UPDATE", candidate.SubmissionID,
		))
		if errors.Is(scanErr, pgx.ErrNoRows) {
			result = identity.SignupReservationResult{Kind: identity.SignupReservationConflict}
			return nil
		}
		if scanErr != nil {
			return scanErr
		}
		if stored.SubmissionID != candidate.SubmissionID || stored.Identity != candidate.Identity {
			result = identity.SignupReservationResult{Kind: identity.SignupReservationConflict}
			return nil
		}
		result = identity.SignupReservationResult{Kind: identity.SignupReservationReserved, Reservation: stored}
		return nil
	})
	if err != nil {
		return identity.SignupReservationResult{}, err
	}
	return result, nil
}

func (store *SignupProvisioningStore) Finalize(
	ctx context.Context,
	plan identity.SignupAdmissionPlan,
	session identity.Session,
	tokenHash identity.SessionTokenHash,
) (identity.SignupFinalizationResult, error) {
	if store == nil || store.pool == nil || !plan.Ready || !plan.Reservation.Valid() ||
		session.Kind != identity.SessionActive || !identity.ValidSession(session) ||
		session.SessionID != plan.Reservation.SessionID || session.AccountID != plan.Reservation.AccountID ||
		session.VaultID != plan.Reservation.VaultID || session.SessionEpoch != plan.Reservation.SessionEpoch {
		return identity.SignupFinalizationResult{}, ErrInvalidSignupOperation
	}
	if _, err := identity.ParseSessionTokenHash(string(tokenHash)); err != nil {
		return identity.SignupFinalizationResult{}, ErrInvalidSignupOperation
	}
	result := identity.SignupFinalizationResult{}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		stored, finalizedAt, storedConsentID, err := scanSignupReservation(transaction.QueryRow(
			ctx, signupReservationSelect+" WHERE submission_id = $1 FOR UPDATE", plan.Reservation.SubmissionID,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return errSignupConflict
		}
		if err != nil {
			return err
		}
		if stored != plan.Reservation {
			return errSignupConflict
		}
		provider, issuer, subject := stored.Identity.ProviderIdentityKey()
		if finalizedAt == nil {
			if err := insertSignupControlPlane(
				ctx, transaction, stored, provider, issuer, subject, plan.ConsentID, session, tokenHash,
			); err != nil {
				if isSignupConstraintViolation(err) || errors.Is(err, ErrConcurrentChange) {
					return errSignupConflict
				}
				return err
			}
			result.Kind = identity.SignupFinalizationCreated
		} else {
			if storedConsentID == nil || *storedConsentID != plan.ConsentID {
				return errSignupConflict
			}
			if err := verifyFinalizedSignup(ctx, transaction, stored, provider, issuer, subject); err != nil {
				return err
			}
			tag, err := transaction.Exec(
				ctx,
				`UPDATE sessions SET token_hash = $1, issued_at = $2, expires_at = $3
				  WHERE session_id = $4 AND account_id = $5 AND vault_id = $6
				    AND session_epoch = $7 AND revoked_at IS NULL AND revocation_reason IS NULL`,
				string(tokenHash), session.IssuedAt, session.ExpiresAt, string(session.SessionID),
				string(session.AccountID), string(session.VaultID), int64(session.SessionEpoch),
			)
			if err != nil {
				if isSignupConstraintViolation(err) {
					return errSignupConflict
				}
				return err
			}
			if tag.RowsAffected() != 1 {
				return errSignupConflict
			}
			result.Kind = identity.SignupFinalizationReplayed
		}
		result.Record = identity.SignupFinalizationRecord{
			Reservation: stored, TermsConsentID: plan.ConsentID,
			IssuedAt: session.IssuedAt, ExpiresAt: session.ExpiresAt,
		}
		return nil
	})
	if errors.Is(err, errSignupConflict) {
		return identity.SignupFinalizationResult{Kind: identity.SignupFinalizationConflict}, nil
	}
	if err != nil {
		return identity.SignupFinalizationResult{}, err
	}
	return result, nil
}

const signupReservationSelect = `SELECT
  submission_id, identity_kind, provider, issuer, subject, verified_email,
  account_id, vault_id, identity_id, session_id, session_epoch, created_at,
  finalized_at, terms_consent_id
FROM signup_admission_reservations`

func scanSignupReservation(row rowScanner) (
	identity.SignupAdmissionReservation,
	*int64,
	*string,
	error,
) {
	var submissionID, identityKind, provider, issuer, subject, verifiedEmail string
	var rawAccountID, rawVaultID, rawIdentityID, rawSessionID string
	var rawSessionEpoch, createdAt int64
	var finalizedAt *int64
	var termsConsentID *string
	if err := row.Scan(
		&submissionID, &identityKind, &provider, &issuer, &subject, &verifiedEmail,
		&rawAccountID, &rawVaultID, &rawIdentityID, &rawSessionID, &rawSessionEpoch, &createdAt,
		&finalizedAt, &termsConsentID,
	); err != nil {
		return identity.SignupAdmissionReservation{}, nil, nil, err
	}
	verifiedIdentity, err := decodeVerifiedSignupIdentity(identityKind, provider, issuer, subject, verifiedEmail)
	if err != nil {
		return identity.SignupAdmissionReservation{}, nil, nil, err
	}
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	identityID, identityErr := identity.ParseIdentityID(rawIdentityID)
	sessionID, sessionErr := identity.ParseSessionID(rawSessionID)
	epoch, epochErr := identity.ParseSessionEpoch(rawSessionEpoch)
	reservation := identity.SignupAdmissionReservation{
		SubmissionID: submissionID, Identity: verifiedIdentity,
		AccountID: accountID, VaultID: vaultID, IdentityID: identityID,
		SessionID: sessionID, SessionEpoch: epoch, CreatedAt: createdAt,
	}
	if accountErr != nil || vaultErr != nil || identityErr != nil || sessionErr != nil || epochErr != nil ||
		!reservation.Valid() || (finalizedAt == nil) != (termsConsentID == nil) ||
		(finalizedAt != nil && (*finalizedAt < createdAt || !validDatabaseTimestamp(*finalizedAt))) ||
		(termsConsentID != nil && !isUUIDv7(*termsConsentID)) {
		return identity.SignupAdmissionReservation{}, nil, nil, ErrInvalidIdentityRecord
	}
	return reservation, finalizedAt, termsConsentID, nil
}

func decodeVerifiedSignupIdentity(
	identityKind string,
	provider string,
	issuer string,
	subject string,
	verifiedEmail string,
) (identity.VerifiedSignupIdentity, error) {
	email, emailErr := identity.ParseVerifiedEmailAddress(verifiedEmail)
	if emailErr != nil || string(email) != verifiedEmail {
		return identity.VerifiedSignupIdentity{}, ErrInvalidIdentityRecord
	}
	switch identity.SignupIdentityKind(identityKind) {
	case identity.SignupIdentityGoogle:
		parsedIssuer, issuerErr := identity.ParseOidcIssuer(issuer)
		parsedSubject, subjectErr := identity.ParseOidcSubject(subject)
		value := identity.VerifiedSignupIdentity{
			Kind: identity.SignupIdentityGoogle, Issuer: parsedIssuer, Subject: parsedSubject, Email: email,
		}
		if provider != "google-oidc" || issuerErr != nil || subjectErr != nil || !value.Valid() {
			return identity.VerifiedSignupIdentity{}, ErrInvalidIdentityRecord
		}
		return value, nil
	case identity.SignupIdentityEmailOtp:
		address, addressErr := identity.ParseEmailOtpAddress(subject)
		value := identity.VerifiedSignupIdentity{Kind: identity.SignupIdentityEmailOtp, Address: address}
		if provider != "email-otp" || issuer != "fukamu.email-otp" || addressErr != nil || string(address) != subject ||
			address.Verified() != email || !value.Valid() {
			return identity.VerifiedSignupIdentity{}, ErrInvalidIdentityRecord
		}
		return value, nil
	default:
		return identity.VerifiedSignupIdentity{}, ErrInvalidIdentityRecord
	}
}

func insertSignupControlPlane(
	ctx context.Context,
	transaction pgx.Tx,
	reservation identity.SignupAdmissionReservation,
	provider string,
	issuer string,
	subject string,
	consentID string,
	session identity.Session,
	tokenHash identity.SessionTokenHash,
) error {
	statements := []struct {
		query string
		args  []interface{}
	}{
		{`INSERT INTO accounts(account_id, created_at) VALUES ($1, $2)`, []interface{}{string(reservation.AccountID), reservation.CreatedAt}},
		{`INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, $3)`, []interface{}{string(reservation.VaultID), string(reservation.AccountID), reservation.CreatedAt}},
		{`INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at)
		  VALUES ($1, $2, $3, $4, $5, $6)`, []interface{}{string(reservation.IdentityID), string(reservation.AccountID), provider, issuer, subject, reservation.CreatedAt}},
		{`INSERT INTO verified_email_owners(email, account_id, verified_at) VALUES ($1, $2, $3)`, []interface{}{string(reservation.Identity.VerifiedEmail()), string(reservation.AccountID), reservation.CreatedAt}},
		{`INSERT INTO sessions(
		    session_id, account_id, vault_id, token_hash, session_epoch,
		    issued_at, expires_at, revoked_at, revocation_reason
		  ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)`, []interface{}{
			string(session.SessionID), string(session.AccountID), string(session.VaultID), string(tokenHash),
			int64(session.SessionEpoch), session.IssuedAt, session.ExpiresAt,
		}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	tag, err := transaction.Exec(
		ctx,
		`UPDATE signup_admission_reservations
		    SET finalized_at = $1, terms_consent_id = $2
		  WHERE submission_id = $3 AND finalized_at IS NULL AND terms_consent_id IS NULL`,
		session.IssuedAt, consentID, reservation.SubmissionID,
	)
	if err != nil {
		return err
	}
	return RequireOneRow(tag)
}

func verifyFinalizedSignup(
	ctx context.Context,
	transaction pgx.Tx,
	reservation identity.SignupAdmissionReservation,
	provider string,
	issuer string,
	subject string,
) error {
	var count int
	err := transaction.QueryRow(
		ctx,
		`SELECT count(*)
		   FROM accounts account
		   JOIN personal_vaults vault
		     ON vault.account_id = account.account_id AND vault.vault_id = $2
		   JOIN identities identity
		     ON identity.account_id = account.account_id AND identity.identity_id = $3
		    AND identity.provider = $4 AND identity.issuer = $5 AND identity.subject = $6
		   JOIN verified_email_owners email
		     ON email.account_id = account.account_id AND email.email = $7
		   JOIN sessions session
		     ON session.account_id = account.account_id AND session.vault_id = vault.vault_id
		    AND session.session_id = $8 AND session.session_epoch = $9
		    AND session.revoked_at IS NULL AND session.revocation_reason IS NULL
		  WHERE account.account_id = $1`,
		string(reservation.AccountID), string(reservation.VaultID), string(reservation.IdentityID),
		provider, issuer, subject, string(reservation.Identity.VerifiedEmail()),
		string(reservation.SessionID), int64(reservation.SessionEpoch),
	).Scan(&count)
	if err != nil {
		return err
	}
	if count != 1 {
		return errSignupConflict
	}
	return nil
}

func isSignupConstraintViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && len(postgresError.Code) >= 2 && postgresError.Code[:2] == "23"
}

func validDatabaseTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}

func isUUIDv7(value string) bool {
	_, err := identity.ParseIdentityID(value)
	return err == nil
}
