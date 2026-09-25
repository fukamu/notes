package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidVaultDEKOperation = errors.New("invalid Vault DEK operation")
	ErrInvalidStoredVaultDEK    = errors.New("invalid stored Vault DEK metadata")
	ErrVaultDEKOwnerMismatch    = errors.New("Vault DEK owner does not exist")
	ErrVaultDEKConflict         = errors.New("Vault DEK metadata conflict")
)

type VaultDEKStore struct {
	pool *pgxpool.Pool
}

func NewVaultDEKStore(pool *pgxpool.Pool) (*VaultDEKStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &VaultDEKStore{pool: pool}, nil
}

func (store *VaultDEKStore) InsertInitial(
	ctx context.Context,
	metadata cryptocontent.VaultDEKMetadata,
) error {
	if store == nil || store.pool == nil || cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
		return ErrInvalidVaultDEKOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO vault_dek_versions(
		   vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		 )
		 SELECT vault_id, $2, $3, $4, true, $5
		   FROM personal_vaults
		  WHERE vault_id = $1`,
		string(metadata.VaultID),
		int64(metadata.DEKVersion),
		metadata.KEKReference,
		metadata.WrappedDEK,
		metadata.CreatedAtMilli,
	)
	if err != nil {
		return classifyVaultDEKWriteError(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrVaultDEKOwnerMismatch
	}
	return nil
}

func (store *VaultDEKStore) FindKeyring(
	ctx context.Context,
	vaultID identity.VaultID,
) (*cryptocontent.VaultDEKKeyring, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidVaultDEKOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return nil, ErrInvalidVaultDEKOperation
	}
	rows, err := store.pool.Query(
		ctx,
		`SELECT vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		   FROM vault_dek_versions
		  WHERE vault_id = $1
		  ORDER BY dek_version`,
		string(vaultID),
	)
	if err != nil {
		return nil, errors.New("read Vault DEK metadata")
	}
	defer rows.Close()
	versions := make([]cryptocontent.VaultDEKMetadata, 0, 4)
	var writeVersion cryptocontent.DEKVersion
	writeCount := 0
	for rows.Next() {
		var rawVaultID, keyReference, wrappedDEK string
		var rawVersion, createdAt int64
		var isWriteKey bool
		if err := rows.Scan(
			&rawVaultID,
			&rawVersion,
			&keyReference,
			&wrappedDEK,
			&isWriteKey,
			&createdAt,
		); err != nil {
			return nil, ErrInvalidStoredVaultDEK
		}
		storedVaultID, err := identity.ParseVaultID(rawVaultID)
		if err != nil {
			return nil, ErrInvalidStoredVaultDEK
		}
		version, err := cryptocontent.ParseDEKVersion(rawVersion)
		if err != nil {
			return nil, ErrInvalidStoredVaultDEK
		}
		metadata := cryptocontent.VaultDEKMetadata{
			VaultID:        storedVaultID,
			DEKVersion:     version,
			KEKReference:   keyReference,
			WrappedDEK:     wrappedDEK,
			CreatedAtMilli: createdAt,
		}
		if cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
			return nil, ErrInvalidStoredVaultDEK
		}
		if isWriteKey {
			writeCount++
			writeVersion = version
		}
		versions = append(versions, metadata)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("read Vault DEK metadata")
	}
	if len(versions) == 0 {
		return nil, nil
	}
	if writeCount != 1 {
		return nil, ErrInvalidStoredVaultDEK
	}
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, writeVersion, versions)
	if err != nil {
		return nil, ErrInvalidStoredVaultDEK
	}
	return &keyring, nil
}

func classifyVaultDEKWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrVaultDEKOwnerMismatch
		case "23505", "23514":
			return ErrVaultDEKConflict
		}
	}
	return errors.New("write Vault DEK metadata")
}
