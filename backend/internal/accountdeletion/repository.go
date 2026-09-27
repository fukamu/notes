package accountdeletion

import "context"

type StartResultKind string
type StartRejectReason string

const (
	StartCreated  StartResultKind = "created"
	StartExisting StartResultKind = "existing"
	StartRejected StartResultKind = "rejected"

	StartCredentialConflict StartRejectReason = "credential-conflict"
	StartInvalid            StartRejectReason = "invalid-start"
)

type AuthorizedSnapshot struct {
	Snapshot     Snapshot
	Continuation Continuation
}

type StartResult struct {
	Kind   StartResultKind
	Reason StartRejectReason
	AuthorizedSnapshot
}

type ConsumeResultKind string
type ConsumeRejectReason string

const (
	ConsumeConsumed ConsumeResultKind = "consumed"
	ConsumeReplayed ConsumeResultKind = "replayed"
	ConsumeRejected ConsumeResultKind = "rejected"

	ConsumeExpired           ConsumeRejectReason = "expired"
	ConsumeInvalidCapability ConsumeRejectReason = "invalid-capability"
)

type ConsumeResult struct {
	Kind   ConsumeResultKind
	Reason ConsumeRejectReason
	AuthorizedSnapshot
}

type CommitResultKind string

const (
	CommitApplied  CommitResultKind = "applied"
	CommitReplayed CommitResultKind = "replayed"
	CommitConflict CommitResultKind = "conflict"
	CommitRejected CommitResultKind = "rejected"
)

type CommitResult struct {
	Kind    CommitResultKind
	Current *Snapshot
}

type Repository interface {
	FindByOwner(context.Context, Scope) (*Snapshot, error)
	Start(context.Context, Operation, Continuation) (StartResult, error)
	Consume(context.Context, CredentialHash, int64, int64) (ConsumeResult, error)
	Commit(context.Context, Scope, Transition) (CommitResult, error)
}
