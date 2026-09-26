//go:build integration

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/localfixture"
)

func TestPrepareE2ERefusesDatabaseAndFilesystemMutationWhileRuntimeLeaseHeld(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS notesctl_lease_guard (id integer PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = database.ExecContext(context.Background(), `DROP TABLE IF EXISTS notesctl_lease_guard`) }()
	lease, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lease.Close() }()
	const leaseNamespace = int64(0x46554b41)
	const leaseKey = int64(0x4d554e4f)
	var backendPID int32
	if err := database.QueryRowContext(ctx, `SELECT pid FROM pg_locks
		WHERE locktype = 'advisory' AND granted
		  AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
		leaseNamespace, leaseKey,
	).Scan(&backendPID); err != nil {
		t.Fatal(err)
	}
	var terminated bool
	if err := database.QueryRowContext(ctx, `SELECT pg_terminate_backend($1)`, backendPID).Scan(&terminated); err != nil || !terminated {
		t.Fatalf("terminate keeper = %t, %v", terminated, err)
	}
	if err := lease.Check(ctx); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) {
		t.Fatalf("lease Check() after termination = %v", err)
	}

	if err := prepareE2EDatabase(ctx, databaseURL, "fixture-owner"); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) {
		t.Fatalf("profile-disabled prepare = %v", err)
	}
	var guard string
	if err := database.QueryRowContext(ctx, `SELECT to_regclass('public.notesctl_lease_guard')::text`).Scan(&guard); err != nil || guard != "notesctl_lease_guard" {
		t.Fatalf("database guard after refused reset = %q, %v", guard, err)
	}

	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	configuration := config.LocalFixtureConfig{
		DatabaseURL:     databaseURL,
		PrivateRoot:     root,
		ObjectDirectory: filepath.Join(root, localfixture.ObjectDirectoryName),
		NonceDirectory:  filepath.Join(root, localfixture.NonceDirectoryName),
		KeyDirectory:    filepath.Join(root, localfixture.KeyDirectoryName),
	}
	owner, _ := access.ParseSubject("fixture-owner")
	if err := prepareLocalFixtureE2EDatabase(ctx, configuration, owner); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) {
		t.Fatalf("local-fixture prepare = %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("fixture root mutated while lease held: %v, %v", entries, err)
	}
}
