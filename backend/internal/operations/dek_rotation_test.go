package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDEKRotationServiceCompletesGeneratingOperationWithStableTimes(t *testing.T) {
	command := testDEKRotationCommand(t)
	executor := &dekRotationExecutorStub{results: []cryptocontent.RotationRunResult{
		pendingDEKRotation(command, cryptocontent.RotationGenerating{}, 1),
		pendingDEKRotation(command, testRotationPromoting(command), 2),
		finishedDEKRotation(command),
	}}
	service, err := NewDEKRotationService(executor)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Run(context.Background(), command)
	if err != nil || result.Kind != DEKRotationCompleted || result.OperationID != command.OperationID {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if len(executor.calls) != 3 || executor.calls[0] != command.RequestedAtMilli ||
		executor.calls[1] != command.GeneratedAtMilli || executor.calls[2] != command.CompletedAtMilli {
		t.Fatalf("calls = %#v", executor.calls)
	}
}

func TestDEKRotationServiceResumesPromotingAndReplaysCompletedWithoutGeneration(t *testing.T) {
	command := testDEKRotationCommand(t)
	tests := []struct {
		name      string
		results   []cryptocontent.RotationRunResult
		want      DEKRotationResultKind
		wantCalls []int64
	}{
		{
			name: "promoting",
			results: []cryptocontent.RotationRunResult{
				pendingDEKRotation(command, testRotationPromoting(command), 2), finishedDEKRotation(command),
			},
			want: DEKRotationCompleted, wantCalls: []int64{command.RequestedAtMilli, command.CompletedAtMilli},
		},
		{
			name:    "completed",
			results: []cryptocontent.RotationRunResult{finishedDEKRotation(command)},
			want:    DEKRotationReplayed, wantCalls: []int64{command.RequestedAtMilli},
		},
		{
			name: "concurrent completion",
			results: []cryptocontent.RotationRunResult{
				pendingDEKRotation(command, cryptocontent.RotationGenerating{}, 1), finishedDEKRotation(command),
			},
			want:      DEKRotationReplayed,
			wantCalls: []int64{command.RequestedAtMilli, command.GeneratedAtMilli},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			executor := &dekRotationExecutorStub{results: testCase.results}
			service, _ := NewDEKRotationService(executor)
			result, err := service.Run(context.Background(), command)
			if err != nil || result.Kind != testCase.want {
				t.Fatalf("result = %#v, error = %v", result, err)
			}
			if len(executor.calls) != len(testCase.wantCalls) {
				t.Fatalf("calls = %#v", executor.calls)
			}
			for index := range testCase.wantCalls {
				if executor.calls[index] != testCase.wantCalls[index] {
					t.Fatalf("calls = %#v", executor.calls)
				}
			}
		})
	}
}

func TestDEKRotationServiceRefusesWithoutFurtherWorkAndFailsClosed(t *testing.T) {
	command := testDEKRotationCommand(t)
	refusal := cryptocontent.RotationRunResult{
		Kind: cryptocontent.RotationRunReject, Reason: cryptocontent.RotationRunNotFound,
	}
	executor := &dekRotationExecutorStub{results: []cryptocontent.RotationRunResult{refusal}}
	service, _ := NewDEKRotationService(executor)
	result, err := service.Run(context.Background(), command)
	if err != nil || result.Kind != DEKRotationRefused || result.Reason != cryptocontent.RotationRunNotFound ||
		len(executor.calls) != 1 {
		t.Fatalf("result = %#v, error = %v, calls = %#v", result, err, executor.calls)
	}

	privateFailure := errors.New("PRIVATE KMS FAILURE")
	executor = &dekRotationExecutorStub{
		results: []cryptocontent.RotationRunResult{pendingDEKRotation(command, cryptocontent.RotationGenerating{}, 1)},
		errAt:   1, err: privateFailure,
	}
	service, _ = NewDEKRotationService(executor)
	if failed, runErr := service.Run(context.Background(), command); failed != (DEKRotationResult{}) ||
		!errors.Is(runErr, privateFailure) || len(executor.calls) != 2 {
		t.Fatalf("failed = %#v, error = %v, calls = %#v", failed, runErr, executor.calls)
	}
}

func TestDEKRotationServiceRejectsMalformedDependencyStateAndCommand(t *testing.T) {
	command := testDEKRotationCommand(t)
	malformed := pendingDEKRotation(command, cryptocontent.RotationGenerating{}, 1)
	malformed.Operation.VaultID = identity.VaultID("01991f20-61d2-7000-8000-000000009999")
	executor := &dekRotationExecutorStub{results: []cryptocontent.RotationRunResult{malformed}}
	service, _ := NewDEKRotationService(executor)
	if result, err := service.Run(context.Background(), command); result != (DEKRotationResult{}) ||
		!errors.Is(err, ErrDEKRotation) {
		t.Fatalf("result = %#v, error = %v", result, err)
	}

	invalid := command
	invalid.CompletedAtMilli = invalid.GeneratedAtMilli - 1
	if ValidateDEKRotationCommand(invalid) == nil {
		t.Fatal("accepted reversed timestamps")
	}
	if _, err := NewDEKRotationService(nil); !errors.Is(err, ErrDEKRotation) {
		t.Fatalf("nil executor error = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	executor = &dekRotationExecutorStub{errAt: 0, err: context.Canceled}
	service, _ = NewDEKRotationService(executor)
	if _, err := service.Run(cancelled, command); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
}

type dekRotationExecutorStub struct {
	results []cryptocontent.RotationRunResult
	calls   []int64
	errAt   int
	err     error
}

func (stub *dekRotationExecutorStub) Start(
	_ context.Context,
	_ cryptocontent.RotationScope,
	_ cryptocontent.RotationOperationID,
	requestedAt int64,
) (cryptocontent.RotationRunResult, error) {
	return stub.next(requestedAt)
}

func (stub *dekRotationExecutorStub) Resume(
	_ context.Context,
	_ cryptocontent.RotationScope,
	_ cryptocontent.RotationOperationID,
	performedAt int64,
) (cryptocontent.RotationRunResult, error) {
	return stub.next(performedAt)
}

func (stub *dekRotationExecutorStub) next(at int64) (cryptocontent.RotationRunResult, error) {
	call := len(stub.calls)
	stub.calls = append(stub.calls, at)
	if stub.err != nil && call == stub.errAt {
		return cryptocontent.RotationRunResult{}, stub.err
	}
	if call >= len(stub.results) {
		return cryptocontent.RotationRunResult{}, errors.New("unexpected DEK rotation call")
	}
	return stub.results[call], nil
}

func testDEKRotationCommand(t *testing.T) DEKRotationCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	operationID, _ := cryptocontent.ParseRotationOperationID("01991f20-61d2-7000-8000-000000000401")
	return DEKRotationCommand{
		AccountID: accountID, VaultID: vaultID, OperationID: operationID,
		RequestedAtMilli: 2_000, GeneratedAtMilli: 2_200, CompletedAtMilli: 2_300,
	}
}

func pendingDEKRotation(
	command DEKRotationCommand,
	state cryptocontent.RotationState,
	revision cryptocontent.RotationRevision,
) cryptocontent.RotationRunResult {
	operation := testRotationOperation(command, state, revision)
	return cryptocontent.RotationRunResult{Kind: cryptocontent.RotationPending, Operation: &operation}
}

func finishedDEKRotation(command DEKRotationCommand) cryptocontent.RotationRunResult {
	state := cryptocontent.RotationCompleted{
		Metadata: testRotationMetadata(command), CompletedAtMilli: command.CompletedAtMilli,
	}
	operation := testRotationOperation(command, state, 3)
	return cryptocontent.RotationRunResult{Kind: cryptocontent.RotationFinished, Operation: &operation}
}

func testRotationPromoting(command DEKRotationCommand) cryptocontent.RotationPromoting {
	return cryptocontent.RotationPromoting{Metadata: testRotationMetadata(command)}
}

func testRotationMetadata(command DEKRotationCommand) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID: command.VaultID, DEKVersion: 2,
		KEKReference: "projects/fukamu-test/locations/asia-northeast1/keyRings/notes/cryptoKeys/vault/cryptoKeyVersions/7",
		WrappedDEK:   "d3JhcHBlZA", CreatedAtMilli: 2_100,
	}
}

func testRotationOperation(
	command DEKRotationCommand,
	state cryptocontent.RotationState,
	revision cryptocontent.RotationRevision,
) cryptocontent.RotationOperation {
	updatedAt := command.RequestedAtMilli
	if revision == 2 {
		updatedAt = command.GeneratedAtMilli
	}
	if revision == 3 {
		updatedAt = command.CompletedAtMilli
	}
	return cryptocontent.RotationOperation{
		RotationScope: cryptocontent.RotationScope{AccountID: command.AccountID, VaultID: command.VaultID},
		OperationID:   command.OperationID, Revision: revision, SourceVersion: 1, TargetVersion: 2,
		State: state, CreatedAtMilli: command.RequestedAtMilli, UpdatedAtMilli: updatedAt,
	}
}
