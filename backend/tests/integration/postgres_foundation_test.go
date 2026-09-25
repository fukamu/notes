//go:build integration

package integration_test

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/httpapi"
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
	assertLaunchGate(t, ctx, pool)
	assertReadiness(t, ctx, pool)
	assertPrivateHTTPVertical(t, ctx, pool)

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

func assertPrivateHTTPVertical(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate local identity key: %v", err)
	}
	verifier, err := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	if err != nil {
		t.Fatalf("NewLocalVerifier() error = %v", err)
	}
	gate, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		t.Fatalf("NewLaunchGateReader() error = %v", err)
	}
	readiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		t.Fatalf("NewSchemaReadiness() error = %v", err)
	}
	legacySync, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		t.Fatalf("NewLegacySyncStore() error = %v", err)
	}
	publicOrigin, _ := url.Parse("https://notes.example")
	owner, _ := access.ParseSubject("private-owner")
	staticDirectory := t.TempDir()
	writeStaticSiteFixture(t, staticDirectory)
	now := time.Unix(1_800_000_000, 0)
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		PrivateRuntime: &httpapi.PrivateRuntime{
			Verifier:     verifier,
			Gate:         gate,
			Readiness:    readiness,
			LegacySync:   legacySync,
			LegacyOwner:  owner,
			PublicOrigin: publicOrigin,
			Clock:        func() time.Time { return now },
		},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequestWithContext(ctx, http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK || !strings.Contains(ready.Body.String(), `"ready"`) {
		t.Fatalf("readiness response = %d %s", ready.Code, ready.Body.String())
	}

	assertion, err := accessadapter.SignLocalAssertion(
		privateKey,
		"https://issuer.test",
		"notes-local",
		owner,
		now.Add(-time.Minute),
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatalf("SignLocalAssertion() error = %v", err)
	}
	approvedRequest := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/launch-status", nil)
	approvedRequest.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	approved := httptest.NewRecorder()
	handler.ServeHTTP(approved, approvedRequest)
	if approved.Code != http.StatusOK || !strings.Contains(approved.Body.String(), `"canAccess":true`) ||
		!strings.Contains(approved.Body.String(), `"authenticated":true`) {
		t.Fatalf("approved launch response = %d %s", approved.Code, approved.Body.String())
	}

	syncRequest := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/sync",
		strings.NewReader(`{"deviceId":"01991f20-61d2-7000-8000-000000001000","mutations":[{"mutationId":"01991f20-61d2-7000-8000-000000001010","cardId":"01991f20-61d2-7000-8000-000000001001","baseServerRevision":null,"title":"Go縦断","body":[],"createdAt":1789000000000,"updatedAt":1789000000100,"kind":"upsert","conflictIds":[]}]}`),
	)
	syncRequest.Header.Set("Content-Type", "application/json")
	syncRequest.Header.Set("Origin", "https://notes.example")
	syncRequest.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	syncResponse := httptest.NewRecorder()
	handler.ServeHTTP(syncResponse, syncRequest)
	if syncResponse.Code != http.StatusOK ||
		!strings.Contains(syncResponse.Body.String(), `"title":"Go縦断"`) ||
		!strings.Contains(syncResponse.Body.String(), `"officialDisplayId":1`) {
		t.Fatalf("sync response = %d %s", syncResponse.Code, syncResponse.Body.String())
	}

	spoofedRequest := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/launch-status", nil)
	spoofedRequest.Header.Set(accessadapter.LegacySitesHeader, string(owner))
	spoofed := httptest.NewRecorder()
	handler.ServeHTTP(spoofed, spoofedRequest)
	if spoofed.Code != http.StatusServiceUnavailable || strings.Contains(spoofed.Body.String(), string(owner)) {
		t.Fatalf("spoofed launch response = %d %s", spoofed.Code, spoofed.Body.String())
	}
}

func writeStaticSiteFixture(t *testing.T, directory string) {
	t.Helper()
	files := []string{
		"index.html", "favicon.svg", "manifest.webmanifest", "og.png", "sw.js",
		"account/billing/index.html", "account/privacy/index.html", "account/terms/index.html",
		"checkout/index.html", "company/index.html", "legal/commercial-transactions/index.html",
		"legal/external-transmission/index.html", "legal/privacy/index.html", "legal/terms/index.html",
		"pricing/index.html",
	}
	for _, filename := range files {
		path := filepath.Join(directory, filepath.FromSlash(filename))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("create static fixture directory: %v", err)
		}
		if err := os.WriteFile(path, []byte("test"), 0o600); err != nil {
			t.Fatalf("write static fixture: %v", err)
		}
	}
}

func assertReadiness(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	readiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		t.Fatalf("NewSchemaReadiness() error = %v", err)
	}
	if err := readiness.Check(ctx); err != nil {
		t.Fatalf("schema readiness error = %v", err)
	}
}

func assertLaunchGate(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	reader, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		t.Fatalf("NewLaunchGateReader() error = %v", err)
	}
	owner, _ := access.ParseSubject("private-owner")
	facts, err := reader.Read(ctx, &owner)
	if err != nil || facts.PublicAccessEnabled || facts.UserAllowed {
		t.Fatalf("closed launch facts = %#v, error = %v", facts, err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, 0)", string(owner)); err != nil {
		t.Fatalf("allow owner: %v", err)
	}
	facts, err = reader.Read(ctx, &owner)
	if err != nil || facts.PublicAccessEnabled || !facts.UserAllowed {
		t.Fatalf("allowed owner facts = %#v, error = %v", facts, err)
	}
	other, _ := access.ParseSubject("other-user")
	facts, err = reader.Read(ctx, &other)
	if err != nil || facts.UserAllowed {
		t.Fatalf("other user facts = %#v, error = %v", facts, err)
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
		"verified_email_owners",
		"signup_admission_reservations",
		"vault_dek_versions",
		"vault_encrypted_objects",
		"vault_encrypted_write_intents",
		"vault_object_delete_outbox",
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
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO verified_email_owners(email, account_id, verified_at) VALUES ('Person@Example.COM', 'account', 0)",
	); err == nil {
		t.Fatal("verified email accepted a non-canonical domain")
	}
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO verified_email_owners(email, account_id, verified_at) VALUES ('Person@example.com', 'account', 0)",
	); err != nil {
		t.Fatalf("insert canonical verified email: %v", err)
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
