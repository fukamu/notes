package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidNonceReservationOperation = errors.New("invalid nonce reservation operation")

type NonceReservationStore struct {
	pool *pgxpool.Pool
}

var _ cryptocontent.NonceReservationPort = (*NonceReservationStore)(nil)

func NewNonceReservationStore(pool *pgxpool.Pool) (*NonceReservationStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &NonceReservationStore{pool: pool}, nil
}

func (store *NonceReservationStore) ReserveNonce(
	ctx context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
	nonce string,
) (bool, error) {
	if store == nil || store.pool == nil || ctx == nil {
		return false, ErrInvalidNonceReservationOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return false, ErrInvalidNonceReservationOperation
	}
	if _, err := cryptocontent.ParseDEKVersion(int64(version)); err != nil {
		return false, ErrInvalidNonceReservationOperation
	}
	decoded, err := cryptocontent.DecodeCanonicalBase64URL(nonce, 16, 16)
	if err != nil || len(decoded) != 12 {
		clear(decoded)
		return false, ErrInvalidNonceReservationOperation
	}
	clear(decoded)
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO content_nonce_reservations(vault_id, dek_version, nonce)
		 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		string(vaultID), int64(version), nonce,
	)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) &&
			(postgresError.Code == "23503" || postgresError.Code == "23514") {
			return false, ErrInvalidNonceReservationOperation
		}
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
