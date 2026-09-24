package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidSessionOperation = errors.New("invalid session operation")
	ErrInvalidSessionRecord    = errors.New("invalid stored session")
	ErrSessionConflict         = errors.New("session identifier conflict")
	ErrSessionOwnerMismatch    = errors.New("session owner mismatch")
	ErrSessionConcurrentChange = errors.New("session changed concurrently")
)

type SessionStore struct {
	pool *pgxpool.Pool
}

type StoredSession struct {
	Session   identity.Session
	TokenHash identity.SessionTokenHash
}

type SessionResolver struct {
	store *SessionStore
}

type SessionMutationOutcome string

const (
	SessionMutationApplied   SessionMutationOutcome = "applied"
	SessionMutationUnchanged SessionMutationOutcome = "unchanged"
)

func NewSessionStore(pool *pgxpool.Pool) (*SessionStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &SessionStore{pool: pool}, nil
}

func NewSessionResolver(store *SessionStore) (*SessionResolver, error) {
	if store == nil || store.pool == nil {
		return nil, errors.New("session store is required")
	}
	return &SessionResolver{store: store}, nil
}

func (resolver *SessionResolver) FindSessionByToken(
	ctx context.Context,
	token identity.SessionToken,
) (*identity.Session, error) {
	if resolver == nil || resolver.store == nil {
		return nil, ErrInvalidSessionOperation
	}
	stored, err := resolver.store.FindSessionByToken(ctx, token)
	if err != nil || stored == nil {
		return nil, err
	}
	session := stored.Session
	return &session, nil
}

func (store *SessionStore) FindSessionByToken(
	ctx context.Context,
	token identity.SessionToken,
) (*StoredSession, error) {
	hash, err := identity.HashSessionToken(token)
	if err != nil {
		return nil, ErrInvalidSessionOperation
	}
	return store.FindSessionByTokenHash(ctx, hash)
}

func (store *SessionStore) FindSessionByTokenHash(
	ctx context.Context,
	hash identity.SessionTokenHash,
) (*StoredSession, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidSessionOperation
	}
	if _, err := identity.ParseSessionTokenHash(string(hash)); err != nil {
		return nil, ErrInvalidSessionOperation
	}
	stored, err := scanStoredSession(store.pool.QueryRow(
		ctx,
		`SELECT session_id, account_id, vault_id, token_hash, session_epoch,
		        issued_at, expires_at, revoked_at, revocation_reason
		   FROM sessions WHERE token_hash = $1`,
		string(hash),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &stored, nil
}

func (store *SessionStore) CreateSession(
	ctx context.Context,
	session identity.Session,
	token identity.SessionToken,
) error {
	if store == nil || store.pool == nil || session.Kind != identity.SessionActive ||
		!identity.ValidSession(session) {
		return ErrInvalidSessionOperation
	}
	hash, err := identity.HashSessionToken(token)
	if err != nil {
		return ErrInvalidSessionOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO sessions(
		   session_id, account_id, vault_id, token_hash, session_epoch,
		   issued_at, expires_at, revoked_at, revocation_reason
		 )
		 SELECT $1, owner.account_id, owner.vault_id, $4, $5, $6, $7, NULL, NULL
		   FROM personal_vaults owner
		  WHERE owner.account_id = $2 AND owner.vault_id = $3`,
		string(session.SessionID),
		string(session.AccountID),
		string(session.VaultID),
		string(hash),
		int64(session.SessionEpoch),
		session.IssuedAt,
		session.ExpiresAt,
	)
	if err != nil {
		return classifySessionWriteError(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrSessionOwnerMismatch
	}
	return nil
}

func (store *SessionStore) RotateSession(
	ctx context.Context,
	currentToken identity.SessionToken,
	rotation identity.RotationDecision,
) error {
	if store == nil || store.pool == nil || !identity.ValidRotation(rotation) {
		return ErrInvalidSessionOperation
	}
	currentHash, err := identity.HashSessionToken(currentToken)
	if err != nil {
		return ErrInvalidSessionOperation
	}
	nextHash, err := identity.HashSessionToken(rotation.NextToken)
	if err != nil || currentHash == nextHash {
		return ErrInvalidSessionOperation
	}
	return store.withSessionTx(ctx, func(transaction pgx.Tx) error {
		previous := rotation.Previous
		tag, err := transaction.Exec(
			ctx,
			`UPDATE sessions
			    SET revoked_at = $1, revocation_reason = 'rotated'
			  WHERE session_id = $2 AND account_id = $3 AND vault_id = $4
			    AND token_hash = $5 AND session_epoch = $6
			    AND issued_at = $7 AND expires_at = $8
			    AND revoked_at IS NULL AND revocation_reason IS NULL`,
			previous.RevokedAt,
			string(previous.SessionID),
			string(previous.AccountID),
			string(previous.VaultID),
			string(currentHash),
			int64(previous.SessionEpoch),
			previous.IssuedAt,
			previous.ExpiresAt,
		)
		if err != nil {
			return classifySessionWriteError(err)
		}
		if tag.RowsAffected() != 1 {
			return ErrSessionConcurrentChange
		}
		current := rotation.Current
		_, err = transaction.Exec(
			ctx,
			`INSERT INTO sessions(
			   session_id, account_id, vault_id, token_hash, session_epoch,
			   issued_at, expires_at, revoked_at, revocation_reason
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)`,
			string(current.SessionID),
			string(current.AccountID),
			string(current.VaultID),
			string(nextHash),
			int64(current.SessionEpoch),
			current.IssuedAt,
			current.ExpiresAt,
		)
		return classifySessionWriteError(err)
	})
}

func (store *SessionStore) RevokeSession(
	ctx context.Context,
	context identity.VaultContext,
	revoked identity.Session,
) (SessionMutationOutcome, error) {
	if store == nil || store.pool == nil || revoked.Kind != identity.SessionRevoked ||
		!identity.ValidSession(revoked) || !identity.SessionMatchesContext(context, revoked) ||
		(revoked.RevocationReason != identity.RevocationLogout &&
			revoked.RevocationReason != identity.RevocationSecurity) {
		return "", ErrInvalidSessionOperation
	}
	outcome := SessionMutationApplied
	err := store.withSessionTx(ctx, func(transaction pgx.Tx) error {
		tag, err := transaction.Exec(
			ctx,
			`UPDATE sessions SET revoked_at = $1, revocation_reason = $2
			  WHERE session_id = $3 AND account_id = $4 AND vault_id = $5
			    AND session_epoch = $6 AND issued_at = $7 AND expires_at = $8
			    AND revoked_at IS NULL AND revocation_reason IS NULL`,
			revoked.RevokedAt,
			string(revoked.RevocationReason),
			string(revoked.SessionID),
			string(revoked.AccountID),
			string(revoked.VaultID),
			int64(revoked.SessionEpoch),
			revoked.IssuedAt,
			revoked.ExpiresAt,
		)
		if err != nil {
			return classifySessionWriteError(err)
		}
		if tag.RowsAffected() == 1 {
			return nil
		}
		stored, err := scanStoredSession(transaction.QueryRow(
			ctx,
			`SELECT session_id, account_id, vault_id, token_hash, session_epoch,
			        issued_at, expires_at, revoked_at, revocation_reason
			   FROM sessions WHERE session_id = $1 FOR UPDATE`,
			string(revoked.SessionID),
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSessionConcurrentChange
		}
		if err != nil {
			return err
		}
		if stored.Session != revoked {
			return ErrSessionConcurrentChange
		}
		outcome = SessionMutationUnchanged
		return nil
	})
	if err != nil {
		return "", err
	}
	return outcome, nil
}

func (store *SessionStore) RevokeAccountSessions(
	ctx context.Context,
	accountID identity.AccountID,
	vaultID identity.VaultID,
	revokedAt int64,
) (int64, error) {
	if store == nil || store.pool == nil || revokedAt < 0 ||
		revokedAt > identity.MaximumSafeInteger {
		return 0, ErrInvalidSessionOperation
	}
	if _, err := identity.ParseAccountID(string(accountID)); err != nil {
		return 0, ErrInvalidSessionOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return 0, ErrInvalidSessionOperation
	}
	var revokedCount int64
	err := store.withSessionTx(ctx, func(transaction pgx.Tx) error {
		var owner int
		if err := transaction.QueryRow(
			ctx,
			`SELECT 1 FROM personal_vaults
			  WHERE account_id = $1 AND vault_id = $2 FOR UPDATE`,
			string(accountID), string(vaultID),
		).Scan(&owner); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrSessionOwnerMismatch
			}
			return err
		}
		tag, err := transaction.Exec(
			ctx,
			`UPDATE sessions SET revoked_at = $1, revocation_reason = 'security'
			  WHERE account_id = $2 AND vault_id = $3
			    AND revoked_at IS NULL AND revocation_reason IS NULL
			    AND issued_at <= $1`,
			revokedAt, string(accountID), string(vaultID),
		)
		if err != nil {
			return classifySessionWriteError(err)
		}
		revokedCount = tag.RowsAffected()
		var remaining int64
		if err := transaction.QueryRow(
			ctx,
			`SELECT count(*) FROM sessions
			  WHERE account_id = $1 AND vault_id = $2
			    AND revoked_at IS NULL AND revocation_reason IS NULL`,
			string(accountID), string(vaultID),
		).Scan(&remaining); err != nil {
			return err
		}
		if remaining != 0 {
			return ErrSessionConcurrentChange
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return revokedCount, nil
}

func (store *SessionStore) withSessionTx(
	ctx context.Context,
	operation func(pgx.Tx) error,
) error {
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		rollbackContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = transaction.Rollback(rollbackContext)
	}()
	if err := operation(transaction); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return classifySessionWriteError(err)
	}
	committed = true
	return nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanStoredSession(row rowScanner) (StoredSession, error) {
	var (
		sessionID, accountID, vaultID, tokenHash string
		epoch, issuedAt, expiresAt               int64
		revokedAt                                pgtype.Int8
		reason                                   pgtype.Text
	)
	if err := row.Scan(
		&sessionID, &accountID, &vaultID, &tokenHash, &epoch,
		&issuedAt, &expiresAt, &revokedAt, &reason,
	); err != nil {
		return StoredSession{}, err
	}
	parsedSessionID, err := identity.ParseSessionID(sessionID)
	if err != nil {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	parsedAccountID, err := identity.ParseAccountID(accountID)
	if err != nil {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	parsedVaultID, err := identity.ParseVaultID(vaultID)
	if err != nil {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	parsedEpoch, err := identity.ParseSessionEpoch(epoch)
	if err != nil {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	parsedHash, err := identity.ParseSessionTokenHash(tokenHash)
	if err != nil {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	session := identity.Session{
		Kind: identity.SessionActive, SessionID: parsedSessionID, AccountID: parsedAccountID,
		VaultID: parsedVaultID, SessionEpoch: parsedEpoch, IssuedAt: issuedAt, ExpiresAt: expiresAt,
	}
	if revokedAt.Valid != reason.Valid {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	if revokedAt.Valid {
		session.Kind = identity.SessionRevoked
		session.RevokedAt = revokedAt.Int64
		session.RevocationReason = identity.RevocationReason(reason.String)
	}
	if !identity.ValidSession(session) {
		return StoredSession{}, ErrInvalidSessionRecord
	}
	return StoredSession{Session: session, TokenHash: parsedHash}, nil
}

func classifySessionWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23505":
			return ErrSessionConflict
		case "23503":
			return ErrSessionOwnerMismatch
		case "23514", "22003":
			return ErrInvalidSessionRecord
		case "40001", "40P01":
			return ErrSessionConcurrentChange
		}
	}
	return err
}
