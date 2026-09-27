//go:build integration

package integration_test

import (
	"context"
	"errors"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestVaultDEKKeyringPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewVaultDEKStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	vaultA := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	seedCryptoVault(t, ctx, pool, "01991f20-61d2-7000-8000-000000000101", vaultA)
	seedCryptoVault(t, ctx, pool, "01991f20-61d2-7000-8000-000000000102", vaultB)
	versionOne, _ := cryptocontent.ParseDEKVersion(1)
	versionTwo, _ := cryptocontent.ParseDEKVersion(2)
	metadataA := cryptoMetadata(vaultA, versionOne, 1_000)
	if err := store.InsertInitial(ctx, metadataA); err != nil {
		t.Fatal(err)
	}
	if err := store.InsertInitial(ctx, cryptoMetadata(vaultB, versionOne, 1_100)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_dek_versions(
		   vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		 ) VALUES ($1, $2, $3, $4, false, $5)`,
		string(vaultA),
		int64(versionTwo),
		cryptoMetadata(vaultA, versionTwo, 2_000).KEKReference,
		cryptoMetadata(vaultA, versionTwo, 2_000).WrappedDEK,
		int64(2_000),
	); err != nil {
		t.Fatal(err)
	}
	keyring, err := store.FindKeyring(ctx, vaultA)
	if err != nil || keyring == nil || keyring.WriteVersion != versionOne || len(keyring.Versions) != 2 {
		t.Fatalf("FindKeyring() = %#v, %v", keyring, err)
	}
	if _, err := keyring.SelectForRead(vaultA, versionTwo); err != nil {
		t.Fatalf("mixed-version read = %v", err)
	}
	if _, err := keyring.SelectForRead(vaultB, versionOne); !errors.Is(err, cryptocontent.ErrVaultMismatch) {
		t.Fatalf("cross-vault read error = %v", err)
	}

	_, err = pool.Exec(
		ctx,
		`INSERT INTO vault_dek_versions(
		   vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		 ) VALUES ($1, 3, 'fake-kek-3', 'd3JhcHBlZC0z', true, 3000)`,
		string(vaultA),
	)
	if err == nil {
		t.Fatal("database accepted a second write key for one Vault")
	}
	missingVault := cryptoMetadata(
		cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000299"),
		versionOne,
		1_000,
	)
	if err := store.InsertInitial(ctx, missingVault); !errors.Is(err, postgresadapter.ErrVaultDEKOwnerMismatch) {
		t.Fatalf("missing owner error = %v", err)
	}

	assertCryptoColumns(t, ctx, pool)
	if _, err := pool.Exec(ctx, "DELETE FROM personal_vaults WHERE vault_id = $1", string(vaultA)); err != nil {
		t.Fatal(err)
	}
	keyring, err = store.FindKeyring(ctx, vaultA)
	if err != nil || keyring != nil {
		t.Fatalf("keyring after Vault deletion = %#v, %v", keyring, err)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func seedCryptoVault(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	accountID string,
	vaultID identity.VaultID,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)", accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, 1000)",
		string(vaultID),
		accountID,
	); err != nil {
		t.Fatal(err)
	}
}

func cryptoVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func cryptoMetadata(
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
	createdAt int64,
) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID:        vaultID,
		DEKVersion:     version,
		KEKReference:   "projects/fukamu-test/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/vault-kek/cryptoKeyVersions/7",
		WrappedDEK:     "ZmFrZS13cmFwcGVkLWRlaw",
		CreatedAtMilli: createdAt,
	}
}

func assertCryptoColumns(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(
		ctx,
		`SELECT column_name
		   FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name = 'vault_dek_versions'
		  ORDER BY ordinal_position`,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, column)
	}
	want := []string{"vault_id", "dek_version", "kek_key_reference", "wrapped_dek", "is_write_key", "created_at"}
	if len(columns) != len(want) {
		t.Fatalf("columns = %v", columns)
	}
	for index := range want {
		if columns[index] != want[index] {
			t.Fatalf("columns = %v", columns)
		}
	}
}
