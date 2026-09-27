package runtimefoundation

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

func TestVaultActivityFenceWaitsForSyncThenSealsEverySyncEntryPoint(t *testing.T) {
	fence := NewVaultActivityFence(false)
	syncStarted := make(chan struct{})
	releaseSync := make(chan struct{})
	delegate := &fenceSyncStub{syncStarted: syncStarted, releaseSync: releaseSync}
	syncApplication, err := NewFencedSyncV2Application(fence, delegate)
	if err != nil {
		t.Fatal(err)
	}
	deletionDelegate := &fenceDeletionStub{result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted}}
	deletion, err := NewFencedAccountDeletionApplication(fence, deletionDelegate)
	if err != nil {
		t.Fatal(err)
	}

	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		_, _ = syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{})
	}()
	<-syncStarted
	startReturned := make(chan struct{})
	go func() {
		_, _ = deletion.Start(context.Background(), accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0)
		close(startReturned)
	}()
	waitFenceSealed(t, fence)
	for range 16 {
		if _, err := syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
			t.Fatalf("sync admitted while deletion drained: %v", err)
		}
	}
	select {
	case <-startReturned:
		t.Fatal("deletion start crossed an active sync")
	default:
	}
	close(releaseSync)
	wait.Wait()
	<-startReturned
	if _, err := syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sealed Synchronize error = %v", err)
	}
	if _, err := syncApplication.DeleteCard(context.Background(), syncv2.DeleteCardInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sealed DeleteCard error = %v", err)
	}
	if delegate.syncCalls != 1 || delegate.deleteCalls != 0 || deletionDelegate.startCalls != 1 {
		t.Fatalf("calls = sync %d delete %d start %d", delegate.syncCalls, delegate.deleteCalls, deletionDelegate.startCalls)
	}
}

func TestVaultActivityFenceSealsAndRepanicsWhenStartDelegatePanics(t *testing.T) {
	fence := NewVaultActivityFence(false)
	deletion, _ := NewFencedAccountDeletionApplication(fence, &fenceDeletionStub{panicStart: true})
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("Start did not propagate delegate panic")
			}
		}()
		_, _ = deletion.Start(context.Background(), accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0)
	}()
	syncApplication, _ := NewFencedSyncV2Application(fence, &fenceSyncStub{})
	if _, err := syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sync after Start panic = %v", err)
	}
}

func TestVaultActivityFenceCancellationAndRejectedStartRemainSealed(t *testing.T) {
	fence := NewVaultActivityFence(false)
	delegate := &fenceSyncStub{}
	syncApplication, _ := NewFencedSyncV2Application(fence, delegate)
	deletionDelegate := &fenceDeletionStub{result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationRejected}}
	deletion, _ := NewFencedAccountDeletionApplication(fence, deletionDelegate)
	if _, err := deletion.Start(context.Background(), accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sync after rejected start = %v", err)
	}

	secondFence := NewVaultActivityFence(false)
	secondSync, _ := NewFencedSyncV2Application(secondFence, &fenceSyncStub{
		syncStarted: make(chan struct{}), releaseSync: make(chan struct{}),
	})
	blocking := secondSync.delegate.(*fenceSyncStub)
	go func() { _, _ = secondSync.Synchronize(context.Background(), syncv2.SynchronizeInput{}) }()
	<-blocking.syncStarted
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	secondDeletion, _ := NewFencedAccountDeletionApplication(secondFence, &fenceDeletionStub{})
	if _, err := secondDeletion.Start(cancelled, accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter error = %v", err)
	}
	if _, err := secondSync.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sync after cancelled deletion start = %v", err)
	}
	close(blocking.releaseSync)
}

func TestVaultActivityFenceAlreadyCancelledStartNeverCallsDelegateWhenDrained(t *testing.T) {
	fence := NewVaultActivityFence(false)
	delegate := &fenceDeletionStub{}
	deletion, err := NewFencedAccountDeletionApplication(fence, delegate)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := deletion.Start(
		cancelled, accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0,
	); !errors.Is(err, context.Canceled) {
		t.Fatalf("Start() error = %v", err)
	}
	if delegate.startCalls != 0 {
		t.Fatalf("cancelled Start() delegate calls = %d", delegate.startCalls)
	}
	syncApplication, _ := NewFencedSyncV2Application(fence, &fenceSyncStub{})
	if _, err := syncApplication.Synchronize(
		context.Background(), syncv2.SynchronizeInput{},
	); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("sync after cancelled Start() = %v", err)
	}
}

func TestLeaseCheckedApplicationsRejectEveryEntryPointBeforeDelegate(t *testing.T) {
	lease := leaseCheckStub{err: errors.New("keeper lost")}
	syncDelegate := &fenceSyncStub{}
	syncApplication, err := NewLeaseCheckedSyncV2Application(&lease, syncDelegate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := syncApplication.Synchronize(context.Background(), syncv2.SynchronizeInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("Synchronize() error = %v", err)
	}
	if _, err := syncApplication.DeleteCard(context.Background(), syncv2.DeleteCardInput{}); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("DeleteCard() error = %v", err)
	}
	deletionDelegate := &fenceDeletionStub{}
	deletion, err := NewLeaseCheckedAccountDeletionApplication(&lease, deletionDelegate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deletion.Start(
		context.Background(), accountdeletion.Scope{}, accountdeletion.StartCommand{}, "", 0,
	); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := deletion.Resume(
		context.Background(), accountdeletion.ResumeCommand{}, 0,
	); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("Resume() error = %v", err)
	}
	privacyDelegate := &privacyRequestStub{}
	privacyApplication, err := NewLeaseCheckedPrivacyRequestApplication(&lease, privacyDelegate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := privacyApplication.Submit(
		context.Background(), privacyrequest.Scope{}, privacyrequest.SubmitCommand{}, "", 0,
	); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("privacy Submit() error = %v", err)
	}
	if _, err := privacyApplication.Status(
		context.Background(), privacyrequest.Scope{}, "",
	); !errors.Is(err, ErrVaultActivityClosed) {
		t.Fatalf("privacy Status() error = %v", err)
	}
	if syncDelegate.syncCalls != 0 || syncDelegate.deleteCalls != 0 ||
		deletionDelegate.startCalls != 0 || deletionDelegate.resumeCalls != 0 ||
		privacyDelegate.submitCalls != 0 || privacyDelegate.statusCalls != 0 || lease.calls != 6 {
		t.Fatalf("calls lease=%d sync=%d delete=%d start=%d resume=%d privacy-submit=%d privacy-status=%d",
			lease.calls, syncDelegate.syncCalls, syncDelegate.deleteCalls,
			deletionDelegate.startCalls, deletionDelegate.resumeCalls,
			privacyDelegate.submitCalls, privacyDelegate.statusCalls)
	}
}

func TestLeaseCheckedPrivacyRequestApplicationDelegatesAfterLeaseCheck(t *testing.T) {
	lease := &leaseCheckStub{}
	delegate := &privacyRequestStub{result: privacyrequest.ApplicationResult{Kind: privacyrequest.ApplicationAccepted}}
	application, err := NewLeaseCheckedPrivacyRequestApplication(lease, delegate)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := application.Submit(
		context.Background(), privacyrequest.Scope{}, privacyrequest.SubmitCommand{}, "", 0,
	); err != nil || result.Kind != privacyrequest.ApplicationAccepted {
		t.Fatalf("Submit() = %#v, %v", result, err)
	}
	if result, err := application.Status(
		context.Background(), privacyrequest.Scope{}, "",
	); err != nil || result.Kind != privacyrequest.ApplicationAccepted {
		t.Fatalf("Status() = %#v, %v", result, err)
	}
	if lease.calls != 2 || delegate.submitCalls != 1 || delegate.statusCalls != 1 {
		t.Fatalf("calls lease=%d submit=%d status=%d", lease.calls, delegate.submitCalls, delegate.statusCalls)
	}
}

func TestLeaseCheckedPrivacyRequestApplicationRejectsIncompleteConstruction(t *testing.T) {
	if _, err := NewLeaseCheckedPrivacyRequestApplication(nil, &privacyRequestStub{}); !errors.Is(err, ErrInvalidFoundation) {
		t.Fatalf("nil lease error = %v", err)
	}
	if _, err := NewLeaseCheckedPrivacyRequestApplication(&leaseCheckStub{}, nil); !errors.Is(err, ErrInvalidFoundation) {
		t.Fatalf("nil delegate error = %v", err)
	}
	var application *LeaseCheckedPrivacyRequestApplication
	if _, err := application.Status(context.Background(), privacyrequest.Scope{}, ""); !errors.Is(err, ErrInvalidFoundation) {
		t.Fatalf("nil receiver error = %v", err)
	}
}

type fenceSyncStub struct {
	syncStarted chan struct{}
	releaseSync chan struct{}
	syncCalls   int
	deleteCalls int
}

func (stub *fenceSyncStub) Synchronize(context.Context, syncv2.SynchronizeInput) (syncv2.ApplicationResult, error) {
	stub.syncCalls++
	if stub.syncStarted != nil {
		close(stub.syncStarted)
		<-stub.releaseSync
	}
	return syncv2.ApplicationResult{}, nil
}

func (stub *fenceSyncStub) DeleteCard(context.Context, syncv2.DeleteCardInput) (syncv2.DeleteCardResult, error) {
	stub.deleteCalls++
	return syncv2.DeleteCardResult{}, nil
}

type fenceDeletionStub struct {
	result      accountdeletion.ApplicationResult
	startCalls  int
	resumeCalls int
	panicStart  bool
}

func (stub *fenceDeletionStub) Start(context.Context, accountdeletion.Scope, accountdeletion.StartCommand, accountdeletion.OperationID, int64) (accountdeletion.ApplicationResult, error) {
	stub.startCalls++
	if stub.panicStart {
		panic("injected start panic")
	}
	return stub.result, nil
}

func (stub *fenceDeletionStub) Resume(context.Context, accountdeletion.ResumeCommand, int64) (accountdeletion.ApplicationResult, error) {
	stub.resumeCalls++
	return stub.result, nil
}

type leaseCheckStub struct {
	err   error
	calls int
}

type privacyRequestStub struct {
	result      privacyrequest.ApplicationResult
	submitCalls int
	statusCalls int
}

func (stub *privacyRequestStub) Submit(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.SubmitCommand,
	privacyrequest.RequestID,
	int64,
) (privacyrequest.ApplicationResult, error) {
	stub.submitCalls++
	return stub.result, nil
}

func (stub *privacyRequestStub) Status(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
) (privacyrequest.ApplicationResult, error) {
	stub.statusCalls++
	return stub.result, nil
}

func (stub *leaseCheckStub) Check(context.Context) error {
	stub.calls++
	return stub.err
}

func waitFenceSealed(t *testing.T, fence *VaultActivityFence) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		fence.mutex.Lock()
		sealed := fence.deleting
		fence.mutex.Unlock()
		if sealed {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("fence did not seal")
}
