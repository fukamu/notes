package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/synclegacy"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestLegacySyncRetriesOnlyBoundedTransactionFailures(t *testing.T) {
	t.Parallel()
	request := synclegacy.Request{Mutations: []synclegacy.Mutation{}}
	valid := synclegacy.Response{
		Cards:                   []synclegacy.Card{},
		Conflicts:               []synclegacy.Conflict{},
		AcknowledgedMutationIDs: []synclegacy.MutationID{},
	}

	t.Run("serialization retry succeeds", func(t *testing.T) {
		t.Parallel()
		attempts := 0
		store := &LegacySyncStore{attempt: func(
			context.Context,
			synclegacy.Request,
		) (synclegacy.Response, error) {
			attempts++
			if attempts < maximumSerializableAttempts {
				return synclegacy.Response{}, &pgconn.PgError{Code: "40001"}
			}
			return valid, nil
		}}
		if _, err := store.Sync(context.Background(), request); err != nil {
			t.Fatalf("Sync() error = %v", err)
		}
		if attempts != maximumSerializableAttempts {
			t.Fatalf("attempts = %d", attempts)
		}
	})

	t.Run("deadlock retry is capped", func(t *testing.T) {
		t.Parallel()
		attempts := 0
		store := &LegacySyncStore{attempt: func(
			context.Context,
			synclegacy.Request,
		) (synclegacy.Response, error) {
			attempts++
			return synclegacy.Response{}, &pgconn.PgError{Code: "40P01"}
		}}
		if _, err := store.Sync(context.Background(), request); !errors.Is(
			err,
			synclegacy.ErrSyncFailed,
		) {
			t.Fatalf("Sync() error = %v", err)
		}
		if attempts != maximumSerializableAttempts {
			t.Fatalf("attempts = %d", attempts)
		}
	})

	t.Run("non-retryable error stops", func(t *testing.T) {
		t.Parallel()
		attempts := 0
		store := &LegacySyncStore{attempt: func(
			context.Context,
			synclegacy.Request,
		) (synclegacy.Response, error) {
			attempts++
			return synclegacy.Response{}, &pgconn.PgError{Code: "23505"}
		}}
		if _, err := store.Sync(context.Background(), request); !errors.Is(
			err,
			synclegacy.ErrSyncFailed,
		) {
			t.Fatalf("Sync() error = %v", err)
		}
		if attempts != 1 {
			t.Fatalf("attempts = %d", attempts)
		}
	})

	t.Run("cancellation stops retries", func(t *testing.T) {
		t.Parallel()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		attempts := 0
		store := &LegacySyncStore{attempt: func(
			context.Context,
			synclegacy.Request,
		) (synclegacy.Response, error) {
			attempts++
			return synclegacy.Response{}, &pgconn.PgError{Code: "40001"}
		}}
		if _, err := store.Sync(ctx, request); !errors.Is(err, synclegacy.ErrSyncFailed) {
			t.Fatalf("Sync() error = %v", err)
		}
		if attempts != 1 {
			t.Fatalf("attempts = %d", attempts)
		}
	})
}
