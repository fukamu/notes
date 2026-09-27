package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidDEKReencryptionScopeOperation = errors.New("invalid DEK re-encryption scope operation")

type DEKReencryptionScopeStore struct {
	pool *pgxpool.Pool
}

func NewDEKReencryptionScopeStore(pool *pgxpool.Pool) (*DEKReencryptionScopeStore, error) {
	if pool == nil {
		return nil, ErrInvalidDEKReencryptionScopeOperation
	}
	return &DEKReencryptionScopeStore{pool: pool}, nil
}

func (store *DEKReencryptionScopeStore) LoadDEKReencryptionScope(
	ctx context.Context,
	command operations.DEKReencryptionCommand,
) (operations.DEKReencryptionScopeLoad, error) {
	if store == nil || store.pool == nil || ctx == nil || operations.ValidateDEKReencryptionCommand(command) != nil {
		return operations.DEKReencryptionScopeLoad{}, ErrInvalidDEKReencryptionScopeOperation
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
		return operations.DEKReencryptionScopeLoad{}, errors.New("read DEK re-encryption owner")
	}
	if !owned {
		return operations.DEKReencryptionScopeLoad{}, nil
	}
	keyStore, err := NewVaultDEKStore(store.pool)
	if err != nil {
		return operations.DEKReencryptionScopeLoad{}, err
	}
	keyring, err := keyStore.FindKeyring(ctx, command.VaultID)
	if err != nil {
		return operations.DEKReencryptionScopeLoad{}, err
	}
	if keyring == nil {
		return operations.DEKReencryptionScopeLoad{}, ErrInvalidStoredVaultDEK
	}
	return operations.DEKReencryptionScopeLoad{Owned: true, Keyring: keyring}, nil
}
