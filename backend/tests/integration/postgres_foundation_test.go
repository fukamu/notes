//go:build integration

package integration_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresFoundation(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 4)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE"); err != nil {
		t.Fatalf("drop test schema: %v", err)
	}
	if _, err := pool.Exec(ctx, "CREATE SCHEMA public"); err != nil {
		t.Fatalf("create test schema: %v", err)
	}

	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenSQL() error = %v", err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatalf("NewMigrator() error = %v", err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("first Up() error = %v", err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("idempotent Up() error = %v", err)
	}
	version, err := migrator.CurrentVersion(ctx)
	if err != nil || version != migrations.LatestVersion {
		t.Fatalf("version = %d, error = %v", version, err)
	}

	assertCoreTables(t, ctx, pool)
	assertConstraints(t, ctx, pool)
	assertZeroRowRollback(t, ctx, pool)

	var originalChecksum string
	if err := pool.QueryRow(ctx, "SELECT checksum FROM notes_goose_checksums WHERE version_id = 1").Scan(&originalChecksum); err != nil {
		t.Fatalf("read original checksum: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE notes_goose_checksums SET checksum = $1 WHERE version_id = 1",
		"sha256:0000000000000000000000000000000000000000000000000000000000000000",
	); err != nil {
		t.Fatalf("tamper checksum: %v", err)
	}
	if err := migrator.Up(ctx); !errors.Is(err, postgresadapter.ErrMigrationDrift) {
		t.Fatalf("drift error = %v, want ErrMigrationDrift", err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE notes_goose_checksums SET checksum = $1 WHERE version_id = 1",
		originalChecksum,
	); err != nil {
		t.Fatalf("restore checksum: %v", err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("Up() after checksum restoration error = %v", err)
	}
}

func assertCoreTables(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{
		"cards",
		"card_mutations",
		"conflicts",
		"sync_state",
		"accounts",
		"personal_vaults",
		"identities",
		"sessions",
		"schema_migrations",
		"launch_config",
		"launch_allowed_users",
		"notes_goose_versions",
		"notes_goose_checksums",
	} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists); err != nil || !exists {
			t.Fatalf("table %s exists = %t, error = %v", table, exists, err)
		}
	}
	var publicAccess bool
	if err := pool.QueryRow(ctx, "SELECT public_access_enabled FROM launch_config WHERE singleton = 1").Scan(&publicAccess); err != nil || publicAccess {
		t.Fatalf("launch gate default = %t, error = %v", publicAccess, err)
	}
	var predicate string
	if err := pool.QueryRow(
		ctx,
		"SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_sessions_active_account'",
	).Scan(&predicate); err != nil || predicate == "" {
		t.Fatalf("partial index = %q, error = %v", predicate, err)
	}
}

func assertConstraints(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO cards(id, display_id, title, body_json, revision, created_at, updated_at, last_mutation_id)
         VALUES ('invalid-card', 0, '', '[]', 1, 0, 0, 'mutation')`,
	); err == nil {
		t.Fatal("display id CHECK accepted zero")
	}
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ('vault', 'missing', 0)",
	); err == nil {
		t.Fatal("owner foreign key accepted a missing account")
	}
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ('account', 0)"); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at) VALUES ('identity-1', 'account', 'email-otp', 'issuer', 'subject', 0)"); err != nil {
		t.Fatalf("insert identity: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at) VALUES ('identity-2', 'account', 'email-otp', 'issuer', 'subject', 0)"); err == nil {
		t.Fatal("issuer and subject uniqueness was not enforced")
	}
}

func assertZeroRowRollback(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	err := postgresadapter.WithSerializableTx(ctx, pool, func(transaction pgx.Tx) error {
		if _, err := transaction.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ('rolled-back-account', 0)"); err != nil {
			return err
		}
		tag, err := transaction.Exec(ctx, "UPDATE accounts SET created_at = 1 WHERE account_id = 'does-not-exist'")
		if err != nil {
			return err
		}
		return postgresadapter.RequireOneRow(tag)
	})
	if !errors.Is(err, postgresadapter.ErrConcurrentChange) {
		t.Fatalf("transaction error = %v, want ErrConcurrentChange", err)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM accounts WHERE account_id = 'rolled-back-account'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled back account count = %d, error = %v", count, err)
	}
}
