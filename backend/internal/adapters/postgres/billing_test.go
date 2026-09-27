package postgres

import (
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestNormalizeBillingCommitClassifiesRetryableTransactionsAsCASConflicts(t *testing.T) {
	t.Parallel()

	for _, code := range []string{"40001", "40P01"} {
		code := code
		t.Run(code, func(t *testing.T) {
			t.Parallel()

			kind, err := normalizeBillingCommit(
				billing.CommitApplied,
				&pgconn.PgError{Code: code},
			)
			if err != nil || kind != billing.CommitConflict {
				t.Fatalf("normalizeBillingCommit() = %q, %v; want conflict, nil", kind, err)
			}
		})
	}
}

func TestNormalizeBillingCommitPreservesNonRetryableFailures(t *testing.T) {
	t.Parallel()

	want := errors.New("database unavailable")
	kind, err := normalizeBillingCommit(billing.CommitApplied, want)
	if kind != billing.CommitApplied || !errors.Is(err, want) {
		t.Fatalf("normalizeBillingCommit() = %q, %v; want applied, database error", kind, err)
	}
}

func TestNormalizeBillingCommitPreservesSuccessfulOutcome(t *testing.T) {
	t.Parallel()

	kind, err := normalizeBillingCommit(billing.CommitReplayed, nil)
	if err != nil || kind != billing.CommitReplayed {
		t.Fatalf("normalizeBillingCommit() = %q, %v; want replayed, nil", kind, err)
	}
}
