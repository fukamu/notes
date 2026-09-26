//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/migrations"
)

func TestLocalFixtureFoundationPostgres(t *testing.T) {
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
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		t.Fatalf("reset fixture schema: %v", err)
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("migrate fixture database: %v", err)
	}

	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := localfixtureadapter.PrepareLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	allowed, _ := access.ParseSubject("fixture-owner")
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	rawToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32))
	token, _ := identity.ParseSessionToken(rawToken)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, vaultID)
	if err != nil {
		t.Fatal(err)
	}
	seed, err := localfixture.NewSeed(allowed, accountID, vaultID, sessionID, epoch, token, metadata)
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgresadapter.NewLocalFixtureStore(pool, seed)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Seed(ctx); err != nil {
		t.Fatalf("Seed() error = %v", err)
	}
	if err := store.Seed(ctx); err != nil {
		t.Fatalf("idempotent Seed() error = %v", err)
	}
	if err := store.Check(ctx); err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	sessions, _ := postgresadapter.NewSessionStore(pool)
	resolver, _ := postgresadapter.NewSessionResolver(sessions)
	resolved, err := resolver.FindSessionByToken(ctx, token)
	if err != nil || resolved == nil || resolved.SessionID != sessionID || resolved.VaultID != vaultID {
		t.Fatalf("fixture session = %#v, %v", resolved, err)
	}
	var rawTokenRows int64
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM sessions WHERE token_hash = $1", rawToken).Scan(&rawTokenRows); err != nil || rawTokenRows != 0 {
		t.Fatalf("raw token rows = %d, error = %v", rawTokenRows, err)
	}
	var billingRows, entitlementRows, keyRows int64
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM billing_subscriptions WHERE account_id = $1 AND vault_id = $2", string(accountID), string(vaultID)).Scan(&billingRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM entitlement_projections WHERE account_id = $1 AND vault_id = $2", string(accountID), string(vaultID)).Scan(&entitlementRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = $1", string(vaultID)).Scan(&keyRows); err != nil {
		t.Fatal(err)
	}
	if billingRows != 1 || entitlementRows != 1 || keyRows != 1 {
		t.Fatalf("fixture rows: billing=%d entitlement=%d keys=%d", billingRows, entitlementRows, keyRows)
	}
	keyFile, err := os.ReadFile(filepath.Join(layout.KeyDirectory, "dek-1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var keyWire struct {
		RawDEK string `json:"rawDek"`
	}
	if err := json.Unmarshal(keyFile, &keyWire); err != nil || keyWire.RawDEK == "" {
		t.Fatalf("decode fixture key file: %v", err)
	}
	var rawDEKRows int64
	if err := pool.QueryRow(
		ctx,
		"SELECT COUNT(*) FROM vault_dek_versions WHERE wrapped_dek = $1 OR kek_key_reference = $1",
		keyWire.RawDEK,
	).Scan(&rawDEKRows); err != nil || rawDEKRows != 0 {
		t.Fatalf("raw DEK rows = %d, error = %v", rawDEKRows, err)
	}
	keys, err := recoverykeyadapter.NewDirectory(layout.KeyDirectory, vaultID)
	if err != nil {
		t.Fatal(err)
	}
	key, err := keys.UnwrapDataKey(ctx, metadata)
	if err != nil {
		t.Fatal(err)
	}
	key.Destroy()

	foreignAccount := "01999c20-9e33-7000-8000-000000000099"
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1)", foreignAccount); err != nil {
		t.Fatal(err)
	}
	if err := store.Check(ctx); !errors.Is(err, postgresadapter.ErrLocalFixtureConflict) {
		t.Fatalf("foreign-scope readiness error = %v", err)
	}
}
