//go:build integration

package integration_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
)

func TestLocalFixtureRuntimeLeaseContendsAndReleasesWithoutConsumingPoolSlot(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	lease, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL)
	if err != nil {
		t.Fatalf("AcquireLocalFixtureRuntimeLease() = %v", err)
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		_ = lease.Close()
		t.Fatalf("OpenPool(max=1) = %v", err)
	}
	defer pool.Close()
	var one int
	if err := pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		_ = lease.Close()
		t.Fatalf("pool query while lease held = %d, %v", one, err)
	}
	if second, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) || second != nil {
		if second != nil {
			_ = second.Close()
		}
		_ = lease.Close()
		t.Fatalf("contending lease = %#v, %v", second, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatalf("lease Close() = %v", err)
	}
	restarted, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL)
	if err != nil {
		t.Fatalf("lease after Close() = %v", err)
	}
	if err := restarted.Close(); err != nil {
		t.Fatalf("restarted lease Close() = %v", err)
	}
}

func TestLocalFixtureRuntimeLeaseRetainsHostExclusionAfterKeeperTermination(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	lease, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		_ = lease.Close()
		t.Fatal(err)
	}
	defer pool.Close()
	const leaseNamespace = int64(0x46554b41)
	const leaseKey = int64(0x4d554e4f)
	var backendPID int32
	if err := pool.QueryRow(ctx, `SELECT pid FROM pg_locks
		WHERE locktype = 'advisory' AND granted
		  AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
		leaseNamespace, leaseKey,
	).Scan(&backendPID); err != nil {
		_ = lease.Close()
		t.Fatal(err)
	}
	var terminated bool
	if err := pool.QueryRow(ctx, `SELECT pg_terminate_backend($1)`, backendPID).Scan(&terminated); err != nil || !terminated {
		_ = lease.Close()
		t.Fatalf("terminate keeper = %t, %v", terminated, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for lease.Check(ctx) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := lease.Check(ctx); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) {
		_ = lease.Close()
		t.Fatalf("Check() after keeper termination = %v", err)
	}

	connection, err := pool.Acquire(ctx)
	if err != nil {
		_ = lease.Close()
		t.Fatal(err)
	}
	var postgresFree bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock($1::int, $2::int)`, leaseNamespace, leaseKey).Scan(&postgresFree); err != nil || !postgresFree {
		connection.Release()
		_ = lease.Close()
		t.Fatalf("PostgreSQL lease after keeper termination = %t, %v", postgresFree, err)
	}
	var unlocked bool
	if err := connection.QueryRow(ctx, `SELECT pg_advisory_unlock($1::int, $2::int)`, leaseNamespace, leaseKey).Scan(&unlocked); err != nil || !unlocked {
		connection.Release()
		_ = lease.Close()
		t.Fatalf("release proof lease = %t, %v", unlocked, err)
	}
	connection.Release()
	if second, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) || second != nil {
		if second != nil {
			_ = second.Close()
		}
		_ = lease.Close()
		t.Fatalf("host-overlapping runtime = %#v, %v", second, err)
	}
	if err := lease.Close(); !errors.Is(err, postgresadapter.ErrLocalFixtureRuntimeLease) {
		t.Fatalf("Close() after keeper termination = %v", err)
	}
	restarted, err := postgresadapter.AcquireLocalFixtureRuntimeLease(ctx, databaseURL)
	if err != nil {
		t.Fatalf("runtime after host release = %v", err)
	}
	if err := restarted.Close(); err != nil {
		t.Fatalf("restarted Close() = %v", err)
	}
}
