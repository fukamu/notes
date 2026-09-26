package operations_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestRecoveryDrillServiceMapsVerifiedAndBlockedResults(t *testing.T) {
	command := recoveryDrillCommand(t)
	backupID, _ := encryptedobject.ParseRecoveryBackupID("backup_operations")
	operationID, _ := cryptocontent.ParseRotationOperationID("01991f20-61d2-7000-8000-000000001901")
	verified := recoveryDrillExecutorStub{result: encryptedobject.RecoveryDrillResult{
		Kind: encryptedobject.RecoveryResultVerified,
		Receipt: &encryptedobject.RecoveryDrillReceipt{
			RecoveryScope: encryptedobject.RecoveryScope{AccountID: command.AccountID, VaultID: command.VaultID},
			BackupID:      backupID, OperationID: operationID, CapturedAt: 2_000, DeleteAfter: 4_000,
			DrilledAt: command.DrilledAt, SourceVersion: 1, TargetVersion: 2,
			ObjectCount: 3, VerifiedVersions: []cryptocontent.DEKVersion{1, 2},
		},
	}}
	service, err := operations.NewRecoveryDrillService(&verified)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Run(context.Background(), command)
	if err != nil || result.Kind != operations.RecoveryDrillVerified || result.ObjectCount != 3 ||
		result.SourceVersion != 1 || result.TargetVersion != 2 || result.VerifiedVersions != 2 || verified.calls != 1 {
		t.Fatalf("result=%#v calls=%d err=%v", result, verified.calls, err)
	}

	blocked := recoveryDrillExecutorStub{result: encryptedobject.RecoveryDrillResult{
		Kind: encryptedobject.RecoveryResultBlocked, Reason: encryptedobject.RecoveryAuthenticationFailed,
	}}
	service, _ = operations.NewRecoveryDrillService(&blocked)
	result, err = service.Run(context.Background(), command)
	if err != nil || result.Kind != operations.RecoveryDrillBlocked ||
		result.Reason != encryptedobject.RecoveryAuthenticationFailed {
		t.Fatalf("blocked=%#v err=%v", result, err)
	}
}

func TestRecoveryDrillServiceRejectsInvalidCommandsResultsAndCancellation(t *testing.T) {
	command := recoveryDrillCommand(t)
	executor := recoveryDrillExecutorStub{}
	service, _ := operations.NewRecoveryDrillService(&executor)
	invalid := command
	invalid.DrilledAt = -1
	if _, err := service.Run(context.Background(), invalid); !errors.Is(err, operations.ErrRecoveryDrill) || executor.calls != 0 {
		t.Fatalf("invalid err=%v calls=%d", err, executor.calls)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := service.Run(cancelled, command); !errors.Is(err, context.Canceled) || executor.calls != 0 {
		t.Fatalf("cancelled err=%v calls=%d", err, executor.calls)
	}

	tests := []encryptedobject.RecoveryDrillResult{
		{},
		{Kind: encryptedobject.RecoveryResultBlocked},
		{Kind: encryptedobject.RecoveryResultBlocked, Reason: encryptedobject.RecoveryAuthenticationFailed, Receipt: &encryptedobject.RecoveryDrillReceipt{}},
		{Kind: encryptedobject.RecoveryResultVerified},
		{Kind: encryptedobject.RecoveryResultVerified, Receipt: &encryptedobject.RecoveryDrillReceipt{RecoveryScope: encryptedobject.RecoveryScope{AccountID: command.AccountID, VaultID: command.VaultID}, DrilledAt: command.DrilledAt}},
	}
	for _, malformed := range tests {
		executor := recoveryDrillExecutorStub{result: malformed}
		service, _ := operations.NewRecoveryDrillService(&executor)
		if _, err := service.Run(context.Background(), command); !errors.Is(err, operations.ErrRecoveryDrill) {
			t.Fatalf("malformed=%#v err=%v", malformed, err)
		}
	}
	if _, err := operations.NewRecoveryDrillService(nil); !errors.Is(err, operations.ErrRecoveryDrill) {
		t.Fatalf("constructor error=%v", err)
	}
}

type recoveryDrillExecutorStub struct {
	result encryptedobject.RecoveryDrillResult
	calls  int
}

func (stub *recoveryDrillExecutorStub) Run(
	_ context.Context,
	_ encryptedobject.RecoveryScope,
	_ int64,
) encryptedobject.RecoveryDrillResult {
	stub.calls++
	return stub.result
}

func recoveryDrillCommand(t *testing.T) operations.RecoveryDrillCommand {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000001101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000001201")
	if err != nil {
		t.Fatal(err)
	}
	return operations.RecoveryDrillCommand{AccountID: accountID, VaultID: vaultID, DrilledAt: 3_000}
}
