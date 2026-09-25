package encryptedobject_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestEvaluateVaultPrivateObjectPurge(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		value encryptedobject.VaultPrivateObjectPurgeEvaluation
		want  encryptedobject.VaultPrivateObjectPurgeResult
	}{
		{
			name: "deleted",
			value: encryptedobject.VaultPrivateObjectPurgeEvaluation{
				PendingBefore: 2, Selected: 2, Confirmed: 2,
			},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind: encryptedobject.VaultPrivateObjectPurgeConfirmed, Outcome: encryptedobject.VaultPrivateObjectPurgeDeleted,
			},
		},
		{
			name:  "already empty",
			value: encryptedobject.VaultPrivateObjectPurgeEvaluation{},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind: encryptedobject.VaultPrivateObjectPurgeConfirmed, Outcome: encryptedobject.VaultPrivateObjectPurgeAlreadyEmpty,
			},
		},
		{
			name: "storage unavailable",
			value: encryptedobject.VaultPrivateObjectPurgeEvaluation{
				PendingBefore: 2, Selected: 1, StorageFailure: 1, PendingAfter: 2,
			},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeStorageUnavailable,
			},
		},
		{
			name: "objects remaining",
			value: encryptedobject.VaultPrivateObjectPurgeEvaluation{
				PendingBefore: 2, Selected: 1, Confirmed: 1, PendingAfter: 1,
			},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeObjectsRemaining,
			},
		},
		{
			name: "malformed counts",
			value: encryptedobject.VaultPrivateObjectPurgeEvaluation{
				PendingBefore: 1, Selected: 2, Confirmed: 2,
			},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeDeleteConfirmationUnavailable,
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := encryptedobject.EvaluateVaultPrivateObjectPurge(test.value); got != test.want {
				t.Fatalf("EvaluateVaultPrivateObjectPurge() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestVaultPrivateObjectPurgeRejectsScopeBeforeIO(t *testing.T) {
	t.Parallel()
	command := privateObjectPurgeCommand(t)
	directory := &purgeDirectoryStub{}
	objects := &deletePortStub{}
	service, err := encryptedobject.NewVaultPrivateObjectPurgeService(
		command.Scope, directory, objects,
		encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: 10, RetryDelayMilli: 100},
	)
	if err != nil {
		t.Fatal(err)
	}
	otherVault, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000299")
	command.Scope.VaultID = otherVault
	result, err := service.PurgeVaultPrivateObjects(context.Background(), command)
	if err != nil || result.Kind != encryptedobject.VaultPrivateObjectPurgeTerminalFailure ||
		result.Reason != encryptedobject.VaultPrivateObjectPurgeOwnerMismatch || directory.calls != 0 || objects.calls != 0 {
		t.Fatalf("PurgeVaultPrivateObjects() = %#v, %v; directory=%d objects=%d", result, err, directory.calls, objects.calls)
	}
}

func TestVaultPrivateObjectPurgeMapsPartialAndStorageFailure(t *testing.T) {
	t.Parallel()
	command := privateObjectPurgeCommand(t)
	entry := privateObjectDeleteEntry(t)
	tests := []struct {
		name           string
		repository     purgeRepositoryStub
		objects        deletePortStub
		want           encryptedobject.VaultPrivateObjectPurgeResult
		wantReschedule bool
	}{
		{
			name: "bounded batch leaves objects",
			repository: purgeRepositoryStub{
				counts: []int64{2, 1}, entries: []encryptedobject.DeleteOutboxEntry{entry},
			},
			objects: deletePortStub{result: encryptedobject.DeleteDeleted},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeObjectsRemaining,
			},
		},
		{
			name: "storage failure is rescheduled",
			repository: purgeRepositoryStub{
				counts: []int64{1, 1}, entries: []encryptedobject.DeleteOutboxEntry{entry},
			},
			objects: deletePortStub{err: errors.New("storage unavailable")},
			want: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeStorageUnavailable,
			},
			wantReschedule: true,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			directory := &purgeDirectoryStub{repository: &test.repository}
			service, err := encryptedobject.NewVaultPrivateObjectPurgeService(
				command.Scope, directory, &test.objects,
				encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: 1, RetryDelayMilli: 100},
			)
			if err != nil {
				t.Fatal(err)
			}
			got, err := service.PurgeVaultPrivateObjects(context.Background(), command)
			if err != nil || got != test.want {
				t.Fatalf("PurgeVaultPrivateObjects() = %#v, %v; want %#v", got, err, test.want)
			}
			if test.wantReschedule {
				if test.repository.rescheduled.AttemptCount != 1 || test.repository.rescheduled.NextAttemptAt != 2_100 {
					t.Fatalf("rescheduled = %#v", test.repository.rescheduled)
				}
			}
		})
	}
}

func TestVaultPrivateObjectPurgeRejectsConfirmationConflict(t *testing.T) {
	t.Parallel()
	command := privateObjectPurgeCommand(t)
	repository := &purgeRepositoryStub{
		counts: []int64{1}, entries: []encryptedobject.DeleteOutboxEntry{privateObjectDeleteEntry(t)},
		confirm: encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationConflict},
	}
	directory := &purgeDirectoryStub{repository: repository}
	objects := &deletePortStub{result: encryptedobject.DeleteDeleted}
	service, _ := encryptedobject.NewVaultPrivateObjectPurgeService(
		command.Scope, directory, objects,
		encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: 10, RetryDelayMilli: 100},
	)
	result, err := service.PurgeVaultPrivateObjects(context.Background(), command)
	if err != nil || result.Kind != encryptedobject.VaultPrivateObjectPurgeRetryableFailure ||
		result.Reason != encryptedobject.VaultPrivateObjectPurgeDeleteConfirmationUnavailable {
		t.Fatalf("PurgeVaultPrivateObjects() = %#v, %v", result, err)
	}
}

func privateObjectPurgeCommand(t *testing.T) encryptedobject.VaultPrivateObjectPurgeCommand {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if err != nil {
		t.Fatal(err)
	}
	operationID, err := encryptedobject.ParsePurgeOperationID("01991f20-61d2-7000-8000-000000000301")
	if err != nil {
		t.Fatal(err)
	}
	return encryptedobject.VaultPrivateObjectPurgeCommand{
		Scope:       encryptedobject.VaultPrivateObjectPurgeScope{AccountID: accountID, VaultID: vaultID},
		OperationID: operationID, PreviousReceiptAt: 1_500, AttemptedAt: 2_000,
	}
}

func privateObjectDeleteEntry(t *testing.T) encryptedobject.DeleteOutboxEntry {
	t.Helper()
	key, err := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("A", 43))
	if err != nil {
		t.Fatal(err)
	}
	return encryptedobject.DeleteOutboxEntry{ObjectKey: key, NextAttemptAt: 1_500, CreatedAtMilli: 1_500}
}

type purgeDirectoryStub struct {
	repository encryptedobject.VaultObjectDeleteOutboxRepository
	result     encryptedobject.DeleteOutboxOpenResult
	err        error
	calls      int
}

func (directory *purgeDirectoryStub) Open(
	_ context.Context,
	_ encryptedobject.VaultPrivateObjectPurgeCommand,
) (encryptedobject.DeleteOutboxOpenResult, error) {
	directory.calls++
	if directory.result.Kind != "" {
		return directory.result, directory.err
	}
	return encryptedobject.DeleteOutboxOpenResult{
		Kind: encryptedobject.DeleteOutboxOpened, Repository: directory.repository,
	}, directory.err
}

type purgeRepositoryStub struct {
	counts      []int64
	entries     []encryptedobject.DeleteOutboxEntry
	confirm     encryptedobject.DeleteOutboxMutationResult
	reschedule  encryptedobject.DeleteOutboxMutationResult
	rescheduled encryptedobject.DeleteOutboxEntry
}

func (repository *purgeRepositoryStub) CountPending(context.Context) (int64, error) {
	value := repository.counts[0]
	repository.counts = repository.counts[1:]
	return value, nil
}

func (repository *purgeRepositoryStub) ListReady(context.Context, int64, int) ([]encryptedobject.DeleteOutboxEntry, error) {
	return append([]encryptedobject.DeleteOutboxEntry(nil), repository.entries...), nil
}

func (repository *purgeRepositoryStub) ConfirmDelete(
	_ context.Context,
	_ encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if repository.confirm.Kind == "" {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
	}
	return repository.confirm, nil
}

func (repository *purgeRepositoryStub) RescheduleDelete(
	_ context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	repository.rescheduled = entry
	if repository.reschedule.Kind == "" {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
	}
	return repository.reschedule, nil
}

type deletePortStub struct {
	result encryptedobject.DeleteResult
	err    error
	calls  int
}

func (port *deletePortStub) Delete(context.Context, encryptedobject.ObjectKey) (encryptedobject.DeleteResult, error) {
	port.calls++
	return port.result, port.err
}
