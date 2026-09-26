package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDeleteOutboxServiceChecksExactOwnerBeforeBoundedDrain(t *testing.T) {
	command := testDeleteOutboxCommand(t)
	loader := &deleteOutboxLoaderStub{owned: true}
	executor := &deleteOutboxExecutorStub{result: encryptedobject.DeleteOutboxDrainBatchResult{
		Completed: 1, Retried: 1, Replayed: 1, Contended: 1, Pending: true,
	}}
	service, err := NewDeleteOutboxService(command.Scope, loader, executor)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Run(context.Background(), command)
	want := DeleteOutboxResult{
		Kind: DeleteOutboxPending, Completed: 1, Retried: 1, Replayed: 1, Contended: 1,
	}
	if err != nil || result != want {
		t.Fatalf("Run() = %#v, %v; want %#v", result, err, want)
	}
	if loader.calls != 1 || executor.calls != 1 || executor.attemptedAt != command.AttemptedAt ||
		executor.retryDelay != command.RetryDelayMilli || executor.limit != command.Limit {
		t.Fatalf("loader=%#v executor=%#v", loader, executor)
	}
}

func TestDeleteOutboxServiceRefusesMismatchedOrUnknownOwnerBeforeEffects(t *testing.T) {
	command := testDeleteOutboxCommand(t)
	loader := &deleteOutboxLoaderStub{owned: true}
	executor := &deleteOutboxExecutorStub{}
	service, _ := NewDeleteOutboxService(command.Scope, loader, executor)
	otherVault, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000299")
	mismatched := command
	mismatched.Scope.VaultID = otherVault
	result, err := service.Run(context.Background(), mismatched)
	if err != nil || result != (DeleteOutboxResult{Kind: DeleteOutboxRefused}) ||
		loader.calls != 0 || executor.calls != 0 {
		t.Fatalf("mismatched Run() = %#v, %v; loader=%d executor=%d", result, err, loader.calls, executor.calls)
	}

	loader.owned = false
	result, err = service.Run(context.Background(), command)
	if err != nil || result != (DeleteOutboxResult{Kind: DeleteOutboxRefused}) ||
		loader.calls != 1 || executor.calls != 0 {
		t.Fatalf("unknown owner Run() = %#v, %v; loader=%d executor=%d", result, err, loader.calls, executor.calls)
	}
}

func TestDeleteOutboxServiceFailsClosedForErrorsAndMalformedResults(t *testing.T) {
	command := testDeleteOutboxCommand(t)
	privateFailure := errors.New("private storage failure")
	service, _ := NewDeleteOutboxService(
		command.Scope,
		&deleteOutboxLoaderStub{owned: true},
		&deleteOutboxExecutorStub{err: privateFailure},
	)
	if result, err := service.Run(context.Background(), command); result != (DeleteOutboxResult{}) ||
		!errors.Is(err, privateFailure) {
		t.Fatalf("failure result = %#v, error = %v", result, err)
	}
	for _, malformed := range []encryptedobject.DeleteOutboxDrainBatchResult{
		{Completed: -1},
		{Completed: command.Limit + 1},
		{Completed: command.Limit, Retried: 1},
	} {
		service, _ = NewDeleteOutboxService(
			command.Scope,
			&deleteOutboxLoaderStub{owned: true},
			&deleteOutboxExecutorStub{result: malformed},
		)
		if _, err := service.Run(context.Background(), command); !errors.Is(err, ErrDeleteOutboxDrain) {
			t.Fatalf("malformed %#v error = %v", malformed, err)
		}
	}
	service, _ = NewDeleteOutboxService(
		command.Scope,
		&deleteOutboxLoaderStub{err: context.Canceled},
		&deleteOutboxExecutorStub{},
	)
	if _, err := service.Run(context.Background(), command); !errors.Is(err, context.Canceled) {
		t.Fatalf("owner cancellation error = %v", err)
	}
}

func TestDeleteOutboxCommandValidationAndDependencies(t *testing.T) {
	valid := testDeleteOutboxCommand(t)
	invalid := []DeleteOutboxCommand{
		{},
		func() DeleteOutboxCommand { value := valid; value.AttemptedAt = 0; return value }(),
		func() DeleteOutboxCommand { value := valid; value.RetryDelayMilli = -1; return value }(),
		func() DeleteOutboxCommand {
			value := valid
			value.AttemptedAt = identity.MaximumSafeInteger
			value.RetryDelayMilli = 1
			return value
		}(),
		func() DeleteOutboxCommand { value := valid; value.Limit = 0; return value }(),
		func() DeleteOutboxCommand { value := valid; value.Limit = 101; return value }(),
	}
	for _, command := range invalid {
		if ValidateDeleteOutboxCommand(command) == nil {
			t.Fatalf("accepted invalid command %#v", command)
		}
	}
	if _, err := NewDeleteOutboxService(DeleteOutboxScope{}, &deleteOutboxLoaderStub{}, &deleteOutboxExecutorStub{}); !errors.Is(err, ErrDeleteOutboxDrain) {
		t.Fatalf("invalid scope error = %v", err)
	}
	if _, err := NewDeleteOutboxService(valid.Scope, nil, &deleteOutboxExecutorStub{}); !errors.Is(err, ErrDeleteOutboxDrain) {
		t.Fatalf("nil loader error = %v", err)
	}
	if _, err := NewDeleteOutboxService(valid.Scope, &deleteOutboxLoaderStub{}, nil); !errors.Is(err, ErrDeleteOutboxDrain) {
		t.Fatalf("nil executor error = %v", err)
	}
}

type deleteOutboxLoaderStub struct {
	owned bool
	err   error
	calls int
}

func (stub *deleteOutboxLoaderStub) OwnsDeleteOutboxScope(
	context.Context,
	DeleteOutboxCommand,
) (bool, error) {
	stub.calls++
	return stub.owned, stub.err
}

type deleteOutboxExecutorStub struct {
	result      encryptedobject.DeleteOutboxDrainBatchResult
	err         error
	calls       int
	attemptedAt int64
	retryDelay  int64
	limit       int
}

func (stub *deleteOutboxExecutorStub) DrainBatch(
	_ context.Context,
	attemptedAt, retryDelay int64,
	limit int,
) (encryptedobject.DeleteOutboxDrainBatchResult, error) {
	stub.calls++
	stub.attemptedAt = attemptedAt
	stub.retryDelay = retryDelay
	stub.limit = limit
	return stub.result, stub.err
}

func testDeleteOutboxCommand(t *testing.T) DeleteOutboxCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	return DeleteOutboxCommand{
		Scope:       DeleteOutboxScope{AccountID: accountID, VaultID: vaultID},
		AttemptedAt: 2_000, RetryDelayMilli: 500, Limit: 4,
	}
}
