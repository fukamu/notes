package vaultdata_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/vaultdata"
)

func TestEvaluateRepositoryResult(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		stored vaultdata.RepositoryResult
		want   vaultdata.PurgeResult
	}{
		{
			name: "purged",
			stored: vaultdata.RepositoryResult{
				Kind: vaultdata.RepositoryPurged, LiveRowsBefore: 4, EnqueuedObjectKeys: 2,
			},
			want: vaultdata.PurgeResult{Kind: vaultdata.PurgeConfirmed, Outcome: vaultdata.OutcomePurged},
		},
		{
			name:   "already purged",
			stored: vaultdata.RepositoryResult{Kind: vaultdata.RepositoryAlreadyPurged},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeConfirmed, Outcome: vaultdata.OutcomeAlreadyPurged},
		},
		{
			name:   "incomplete",
			stored: vaultdata.RepositoryResult{Kind: vaultdata.RepositoryIncomplete, LiveRowsBefore: 2},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeRetryableFailure, Reason: vaultdata.FailureIncomplete},
		},
		{
			name:   "owner mismatch",
			stored: vaultdata.RepositoryResult{Kind: vaultdata.RepositoryOwnerMismatch},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeTerminalFailure, Reason: vaultdata.FailureOwnerMismatch},
		},
		{
			name:   "integrity failure",
			stored: vaultdata.RepositoryResult{Kind: vaultdata.RepositoryIntegrityFailure, LiveRowsBefore: 1},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeTerminalFailure, Reason: vaultdata.FailureIntegrity},
		},
		{
			name:   "malformed success",
			stored: vaultdata.RepositoryResult{Kind: vaultdata.RepositoryPurged},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeRetryableFailure, Reason: vaultdata.FailureMalformedResult},
		},
		{
			name:   "unknown kind",
			stored: vaultdata.RepositoryResult{},
			want:   vaultdata.PurgeResult{Kind: vaultdata.PurgeRetryableFailure, Reason: vaultdata.FailureMalformedResult},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := vaultdata.EvaluateRepositoryResult(test.stored); got != test.want {
				t.Fatalf("EvaluateRepositoryResult() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestServiceValidatesCommandAndMapsRepositoryFailure(t *testing.T) {
	t.Parallel()
	valid := purgeCommand(t)
	dependencyErr := errors.New("database unavailable")
	repository := &purgeRepository{err: dependencyErr}
	service, err := vaultdata.NewService(repository)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	result, err := service.Purge(context.Background(), valid)
	if err != nil || result.Kind != vaultdata.PurgeRetryableFailure ||
		result.Reason != vaultdata.FailureRepositoryUnavailable || repository.calls != 1 {
		t.Fatalf("Purge() = %#v, %v; calls = %d", result, err, repository.calls)
	}

	repository.err = nil
	invalid := valid
	invalid.RequestedAt = -1
	result, err = service.Purge(context.Background(), invalid)
	if err != nil || result.Kind != vaultdata.PurgeTerminalFailure ||
		result.Reason != vaultdata.FailureInvalidCommand || repository.calls != 1 {
		t.Fatalf("invalid Purge() = %#v, %v; calls = %d", result, err, repository.calls)
	}
}

func TestNewServiceRejectsMissingRepository(t *testing.T) {
	t.Parallel()
	if _, err := vaultdata.NewService(nil); !errors.Is(err, vaultdata.ErrInvalidConfiguration) {
		t.Fatalf("NewService(nil) error = %v", err)
	}
}

type purgeRepository struct {
	result vaultdata.RepositoryResult
	err    error
	calls  int
}

func (repository *purgeRepository) PurgeVaultData(
	_ context.Context,
	_ vaultdata.PurgeCommand,
) (vaultdata.RepositoryResult, error) {
	repository.calls++
	return repository.result, repository.err
}

func purgeCommand(t *testing.T) vaultdata.PurgeCommand {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if err != nil {
		t.Fatal(err)
	}
	operationID, err := vaultdata.ParseOperationID("01991f20-61d2-7000-8000-000000000301")
	if err != nil {
		t.Fatal(err)
	}
	return vaultdata.PurgeCommand{
		Scope:       vaultdata.Scope{AccountID: accountID, VaultID: vaultID},
		OperationID: operationID, RequestedAt: 1_000,
	}
}
