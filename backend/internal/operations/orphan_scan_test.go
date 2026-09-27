package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestOrphanScanServiceChecksOwnerBeforeRunningBoundedBatch(t *testing.T) {
	command := testOrphanScanCommand(t)
	loader := &orphanScanLoaderStub{owned: true}
	executor := &orphanScanExecutorStub{result: encryptedobject.OrphanCollectionBatchResult{
		Enqueued: command.Limit, Pending: true,
	}}
	service, err := NewOrphanScanService(loader, executor)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Run(context.Background(), command)
	if err != nil || result != (OrphanScanResult{Kind: OrphanScanPending, Enqueued: command.Limit}) {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if loader.calls != 1 || executor.calls != 1 || executor.scan != command.ScanStartedAt ||
		executor.grace != command.GracePeriodMilli || executor.limit != command.Limit {
		t.Fatalf("loader calls=%d executor=%#v", loader.calls, executor)
	}
}

func TestOrphanScanServiceRefusesUnknownOwnerBeforeInventory(t *testing.T) {
	service, _ := NewOrphanScanService(&orphanScanLoaderStub{}, &orphanScanExecutorStub{})
	result, err := service.Run(context.Background(), testOrphanScanCommand(t))
	if err != nil || result != (OrphanScanResult{Kind: OrphanScanRefused}) {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if service.executor.(*orphanScanExecutorStub).calls != 0 {
		t.Fatal("executor ran before owner refusal")
	}
}

func TestOrphanScanServiceFailsClosedForErrorsAndMalformedResults(t *testing.T) {
	command := testOrphanScanCommand(t)
	privateFailure := errors.New("private inventory failure")
	service, _ := NewOrphanScanService(
		&orphanScanLoaderStub{owned: true},
		&orphanScanExecutorStub{err: privateFailure},
	)
	if result, err := service.Run(context.Background(), command); result != (OrphanScanResult{}) ||
		!errors.Is(err, privateFailure) {
		t.Fatalf("failure result = %#v, error = %v", result, err)
	}
	for _, malformed := range []encryptedobject.OrphanCollectionBatchResult{
		{Enqueued: -1},
		{Enqueued: command.Limit + 1},
		{Enqueued: command.Limit - 1, Pending: true},
	} {
		service, _ = NewOrphanScanService(
			&orphanScanLoaderStub{owned: true},
			&orphanScanExecutorStub{result: malformed},
		)
		if _, err := service.Run(context.Background(), command); !errors.Is(err, ErrOrphanScan) {
			t.Fatalf("malformed %#v error = %v", malformed, err)
		}
	}
	service, _ = NewOrphanScanService(
		&orphanScanLoaderStub{err: context.Canceled},
		&orphanScanExecutorStub{},
	)
	if _, err := service.Run(context.Background(), command); !errors.Is(err, context.Canceled) {
		t.Fatalf("owner cancellation error = %v", err)
	}
}

func TestOrphanScanCommandValidationAndDependencies(t *testing.T) {
	valid := testOrphanScanCommand(t)
	invalid := []OrphanScanCommand{
		{},
		func() OrphanScanCommand { value := valid; value.ScanStartedAt = 0; return value }(),
		func() OrphanScanCommand { value := valid; value.GracePeriodMilli = -1; return value }(),
		func() OrphanScanCommand { value := valid; value.Limit = 0; return value }(),
		func() OrphanScanCommand { value := valid; value.Limit = 101; return value }(),
	}
	for _, command := range invalid {
		if ValidateOrphanScanCommand(command) == nil {
			t.Fatalf("accepted invalid command %#v", command)
		}
	}
	if _, err := NewOrphanScanService(nil, &orphanScanExecutorStub{}); !errors.Is(err, ErrOrphanScan) {
		t.Fatalf("nil loader error = %v", err)
	}
	if _, err := NewOrphanScanService(&orphanScanLoaderStub{}, nil); !errors.Is(err, ErrOrphanScan) {
		t.Fatalf("nil executor error = %v", err)
	}
}

type orphanScanLoaderStub struct {
	owned bool
	err   error
	calls int
}

func (stub *orphanScanLoaderStub) OwnsOrphanScanScope(context.Context, OrphanScanCommand) (bool, error) {
	stub.calls++
	return stub.owned, stub.err
}

type orphanScanExecutorStub struct {
	result encryptedobject.OrphanCollectionBatchResult
	err    error
	calls  int
	scan   int64
	grace  int64
	limit  int
}

func (stub *orphanScanExecutorStub) CollectBatch(
	_ context.Context,
	scan, grace int64,
	limit int,
) (encryptedobject.OrphanCollectionBatchResult, error) {
	stub.calls++
	stub.scan = scan
	stub.grace = grace
	stub.limit = limit
	return stub.result, stub.err
}

func testOrphanScanCommand(t *testing.T) OrphanScanCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	return OrphanScanCommand{
		AccountID: accountID, VaultID: vaultID,
		ScanStartedAt: 10_000, GracePeriodMilli: 1_000, Limit: 2,
	}
}
