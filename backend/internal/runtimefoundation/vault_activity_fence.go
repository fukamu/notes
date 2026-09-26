package runtimefoundation

import (
	"context"
	"errors"
	"sync"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

var ErrVaultActivityClosed = errors.New("vault activity is closed")

type RuntimeLease interface {
	Check(context.Context) error
}

// VaultActivityFence serializes destructive account-deletion admission with
// every local-fixture Sync entry point. Once deletion is admitted the fence is
// permanently sealed for the lifetime of the process.
type VaultActivityFence struct {
	mutex    sync.Mutex
	active   int
	drained  chan struct{}
	deleting bool
}

func NewVaultActivityFence(deleting bool) *VaultActivityFence {
	drained := make(chan struct{})
	close(drained)
	return &VaultActivityFence{drained: drained, deleting: deleting}
}

func (fence *VaultActivityFence) enterSync(ctx context.Context) error {
	if fence == nil || ctx == nil || fence.drained == nil {
		return ErrInvalidFoundation
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	fence.mutex.Lock()
	defer fence.mutex.Unlock()
	if fence.deleting {
		return ErrVaultActivityClosed
	}
	if fence.active == 0 {
		fence.drained = make(chan struct{})
	}
	fence.active++
	return nil
}

func (fence *VaultActivityFence) leaveSync() {
	fence.mutex.Lock()
	defer fence.mutex.Unlock()
	if fence.active < 1 {
		panic("vault activity fence released without an active sync")
	}
	fence.active--
	if fence.active == 0 {
		close(fence.drained)
	}
}

func (fence *VaultActivityFence) sealAndWait(ctx context.Context) error {
	if fence == nil || ctx == nil || fence.drained == nil {
		return ErrInvalidFoundation
	}
	fence.mutex.Lock()
	fence.deleting = true
	drained := fence.drained
	fence.mutex.Unlock()
	// A cancelled destructive request must never win a select race against an
	// already-drained vault and reach the delegate.
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-drained:
		return nil
	}
}

type syncV2Application interface {
	Synchronize(context.Context, syncv2.SynchronizeInput) (syncv2.ApplicationResult, error)
	DeleteCard(context.Context, syncv2.DeleteCardInput) (syncv2.DeleteCardResult, error)
}

type FencedSyncV2Application struct {
	fence    *VaultActivityFence
	delegate syncV2Application
}

// LeaseCheckedSyncV2Application prevents the pool-backed runtime from
// continuing after its dedicated PostgreSQL keeper session loses ownership.
// The companion host flock prevents a replacement process from overlapping a
// request that passed this check immediately before a keeper failure.
type LeaseCheckedSyncV2Application struct {
	lease    RuntimeLease
	delegate syncV2Application
}

func NewLeaseCheckedSyncV2Application(
	lease RuntimeLease,
	delegate syncV2Application,
) (*LeaseCheckedSyncV2Application, error) {
	if lease == nil || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &LeaseCheckedSyncV2Application{lease: lease, delegate: delegate}, nil
}

func (application *LeaseCheckedSyncV2Application) Synchronize(
	ctx context.Context,
	input syncv2.SynchronizeInput,
) (syncv2.ApplicationResult, error) {
	if application == nil || application.lease == nil || application.delegate == nil {
		return syncv2.ApplicationResult{}, ErrInvalidFoundation
	}
	if err := application.lease.Check(ctx); err != nil {
		return syncv2.ApplicationResult{}, ErrVaultActivityClosed
	}
	return application.delegate.Synchronize(ctx, input)
}

func (application *LeaseCheckedSyncV2Application) DeleteCard(
	ctx context.Context,
	input syncv2.DeleteCardInput,
) (syncv2.DeleteCardResult, error) {
	if application == nil || application.lease == nil || application.delegate == nil {
		return syncv2.DeleteCardResult{}, ErrInvalidFoundation
	}
	if err := application.lease.Check(ctx); err != nil {
		return syncv2.DeleteCardResult{}, ErrVaultActivityClosed
	}
	return application.delegate.DeleteCard(ctx, input)
}

func NewFencedSyncV2Application(
	fence *VaultActivityFence,
	delegate syncV2Application,
) (*FencedSyncV2Application, error) {
	if fence == nil || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &FencedSyncV2Application{fence: fence, delegate: delegate}, nil
}

func (application *FencedSyncV2Application) Synchronize(
	ctx context.Context,
	input syncv2.SynchronizeInput,
) (syncv2.ApplicationResult, error) {
	if application == nil || application.fence == nil || application.delegate == nil {
		return syncv2.ApplicationResult{}, ErrInvalidFoundation
	}
	if err := application.fence.enterSync(ctx); err != nil {
		return syncv2.ApplicationResult{}, err
	}
	defer application.fence.leaveSync()
	return application.delegate.Synchronize(ctx, input)
}

func (application *FencedSyncV2Application) DeleteCard(
	ctx context.Context,
	input syncv2.DeleteCardInput,
) (syncv2.DeleteCardResult, error) {
	if application == nil || application.fence == nil || application.delegate == nil {
		return syncv2.DeleteCardResult{}, ErrInvalidFoundation
	}
	if err := application.fence.enterSync(ctx); err != nil {
		return syncv2.DeleteCardResult{}, err
	}
	defer application.fence.leaveSync()
	return application.delegate.DeleteCard(ctx, input)
}

type accountDeletionApplication interface {
	Start(context.Context, accountdeletion.Scope, accountdeletion.StartCommand, accountdeletion.OperationID, int64) (accountdeletion.ApplicationResult, error)
	Resume(context.Context, accountdeletion.ResumeCommand, int64) (accountdeletion.ApplicationResult, error)
}

type FencedAccountDeletionApplication struct {
	fence    *VaultActivityFence
	delegate accountDeletionApplication
}

type LeaseCheckedAccountDeletionApplication struct {
	lease    RuntimeLease
	delegate accountDeletionApplication
}

func NewLeaseCheckedAccountDeletionApplication(
	lease RuntimeLease,
	delegate accountDeletionApplication,
) (*LeaseCheckedAccountDeletionApplication, error) {
	if lease == nil || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &LeaseCheckedAccountDeletionApplication{lease: lease, delegate: delegate}, nil
}

func (application *LeaseCheckedAccountDeletionApplication) Start(
	ctx context.Context,
	scope accountdeletion.Scope,
	command accountdeletion.StartCommand,
	operationID accountdeletion.OperationID,
	requestedAt int64,
) (accountdeletion.ApplicationResult, error) {
	if application == nil || application.lease == nil || application.delegate == nil {
		return accountdeletion.ApplicationResult{}, ErrInvalidFoundation
	}
	if err := application.lease.Check(ctx); err != nil {
		return accountdeletion.ApplicationResult{}, ErrVaultActivityClosed
	}
	return application.delegate.Start(ctx, scope, command, operationID, requestedAt)
}

func (application *LeaseCheckedAccountDeletionApplication) Resume(
	ctx context.Context,
	command accountdeletion.ResumeCommand,
	resumedAt int64,
) (accountdeletion.ApplicationResult, error) {
	if application == nil || application.lease == nil || application.delegate == nil {
		return accountdeletion.ApplicationResult{}, ErrInvalidFoundation
	}
	if err := application.lease.Check(ctx); err != nil {
		return accountdeletion.ApplicationResult{}, ErrVaultActivityClosed
	}
	return application.delegate.Resume(ctx, command, resumedAt)
}

func NewFencedAccountDeletionApplication(
	fence *VaultActivityFence,
	delegate accountDeletionApplication,
) (*FencedAccountDeletionApplication, error) {
	if fence == nil || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &FencedAccountDeletionApplication{fence: fence, delegate: delegate}, nil
}

func (application *FencedAccountDeletionApplication) Start(
	ctx context.Context,
	scope accountdeletion.Scope,
	command accountdeletion.StartCommand,
	operationID accountdeletion.OperationID,
	requestedAt int64,
) (accountdeletion.ApplicationResult, error) {
	if application == nil || application.fence == nil || application.delegate == nil {
		return accountdeletion.ApplicationResult{}, ErrInvalidFoundation
	}
	if err := application.fence.sealAndWait(ctx); err != nil {
		return accountdeletion.ApplicationResult{}, err
	}
	result, err := application.delegate.Start(ctx, scope, command, operationID, requestedAt)
	return result, err
}

func (application *FencedAccountDeletionApplication) Resume(
	ctx context.Context,
	command accountdeletion.ResumeCommand,
	resumedAt int64,
) (accountdeletion.ApplicationResult, error) {
	if application == nil || application.fence == nil || application.delegate == nil {
		return accountdeletion.ApplicationResult{}, ErrInvalidFoundation
	}
	return application.delegate.Resume(ctx, command, resumedAt)
}

// ScopedAccountDeletionRepository makes the configured disposable owner an
// invariant for both authenticated start and capability-only continuation.
type ScopedAccountDeletionRepository struct {
	expected accountdeletion.Scope
	delegate accountdeletion.Repository
}

func NewScopedAccountDeletionRepository(
	expected accountdeletion.Scope,
	delegate accountdeletion.Repository,
) (*ScopedAccountDeletionRepository, error) {
	if !accountdeletion.ValidScope(expected) || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &ScopedAccountDeletionRepository{expected: expected, delegate: delegate}, nil
}

func (repository *ScopedAccountDeletionRepository) FindByOwner(
	ctx context.Context,
	scope accountdeletion.Scope,
) (*accountdeletion.Snapshot, error) {
	if repository == nil || repository.delegate == nil || scope != repository.expected {
		return nil, ErrVaultActivityClosed
	}
	snapshot, err := repository.delegate.FindByOwner(ctx, scope)
	if err != nil || snapshot == nil {
		return snapshot, err
	}
	if snapshot.Operation.Scope != repository.expected {
		return nil, ErrVaultActivityClosed
	}
	return snapshot, nil
}

func (repository *ScopedAccountDeletionRepository) Start(
	ctx context.Context,
	operation accountdeletion.Operation,
	continuation accountdeletion.Continuation,
) (accountdeletion.StartResult, error) {
	if repository == nil || repository.delegate == nil || operation.Scope != repository.expected {
		return accountdeletion.StartResult{Kind: accountdeletion.StartRejected, Reason: accountdeletion.StartInvalid}, nil
	}
	result, err := repository.delegate.Start(ctx, operation, continuation)
	if err != nil {
		return accountdeletion.StartResult{}, err
	}
	if (result.Kind == accountdeletion.StartCreated || result.Kind == accountdeletion.StartExisting) &&
		result.Snapshot.Operation.Scope != repository.expected {
		return accountdeletion.StartResult{}, ErrVaultActivityClosed
	}
	return result, nil
}

func (repository *ScopedAccountDeletionRepository) Consume(
	ctx context.Context,
	secret accountdeletion.CredentialHash,
	sequence int64,
	consumedAt int64,
) (accountdeletion.ConsumeResult, error) {
	if repository == nil || repository.delegate == nil {
		return accountdeletion.ConsumeResult{}, ErrInvalidFoundation
	}
	result, err := repository.delegate.Consume(ctx, secret, sequence, consumedAt)
	if err != nil {
		return accountdeletion.ConsumeResult{}, err
	}
	if (result.Kind == accountdeletion.ConsumeConsumed || result.Kind == accountdeletion.ConsumeReplayed) &&
		result.Snapshot.Operation.Scope != repository.expected {
		return accountdeletion.ConsumeResult{}, ErrVaultActivityClosed
	}
	return result, nil
}

func (repository *ScopedAccountDeletionRepository) Commit(
	ctx context.Context,
	scope accountdeletion.Scope,
	transition accountdeletion.Transition,
) (accountdeletion.CommitResult, error) {
	if repository == nil || repository.delegate == nil || scope != repository.expected ||
		transition.Current.Scope != repository.expected || transition.Next.Scope != repository.expected {
		return accountdeletion.CommitResult{Kind: accountdeletion.CommitRejected}, nil
	}
	result, err := repository.delegate.Commit(ctx, scope, transition)
	if err != nil || result.Current == nil {
		return result, err
	}
	if result.Current.Operation.Scope != repository.expected {
		return accountdeletion.CommitResult{}, ErrVaultActivityClosed
	}
	return result, nil
}
