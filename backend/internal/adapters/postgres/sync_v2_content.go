package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SyncV2MetadataDirectory struct {
	pool *pgxpool.Pool
}

var _ syncv2.MetadataDirectory = (*SyncV2MetadataDirectory)(nil)

func NewSyncV2MetadataDirectory(pool *pgxpool.Pool) (*SyncV2MetadataDirectory, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &SyncV2MetadataDirectory{pool: pool}, nil
}

func (directory *SyncV2MetadataDirectory) Open(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (syncv2.MetadataOpenResult, error) {
	if directory == nil || directory.pool == nil {
		return syncv2.MetadataOpenResult{}, ErrInvalidEncryptedObjectOperation
	}
	if _, err := identity.ParseAccountID(string(vaultContext.AccountID)); err != nil {
		return syncv2.MetadataOpenResult{}, ErrInvalidEncryptedObjectOperation
	}
	if _, err := identity.ParseVaultID(string(vaultContext.VaultID)); err != nil {
		return syncv2.MetadataOpenResult{}, ErrInvalidEncryptedObjectOperation
	}
	var owned bool
	if err := directory.pool.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults
		    WHERE account_id = $1 AND vault_id = $2
		 )`,
		string(vaultContext.AccountID), string(vaultContext.VaultID),
	).Scan(&owned); err != nil {
		return syncv2.MetadataOpenResult{}, errors.New("open Sync v2 encrypted metadata scope")
	}
	if !owned {
		return syncv2.MetadataOpenResult{Kind: syncv2.ContentOwnerMismatch}, nil
	}
	repository, err := NewEncryptedObjectStore(directory.pool, vaultContext.VaultID)
	if err != nil {
		return syncv2.MetadataOpenResult{}, err
	}
	return syncv2.MetadataOpenResult{
		Kind: syncv2.ContentOpened, Repository: repository,
	}, nil
}
