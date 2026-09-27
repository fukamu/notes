package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidOrphanScanScopeOperation = errors.New("invalid orphan scan scope operation")

type OrphanScanScopeStore struct {
	pool *pgxpool.Pool
}

func NewOrphanScanScopeStore(pool *pgxpool.Pool) (*OrphanScanScopeStore, error) {
	if pool == nil {
		return nil, ErrInvalidOrphanScanScopeOperation
	}
	return &OrphanScanScopeStore{pool: pool}, nil
}

func (store *OrphanScanScopeStore) OwnsOrphanScanScope(
	ctx context.Context,
	command operations.OrphanScanCommand,
) (bool, error) {
	if store == nil || store.pool == nil || ctx == nil || operations.ValidateOrphanScanCommand(command) != nil {
		return false, ErrInvalidOrphanScanScopeOperation
	}
	var owned bool
	if err := store.pool.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
		 )`,
		string(command.AccountID),
		string(command.VaultID),
	).Scan(&owned); err != nil {
		return false, errors.New("read orphan scan owner")
	}
	return owned, nil
}
