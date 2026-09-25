package privacyrequest

import "context"

type CreateKind string

const (
	CreateCreated  CreateKind = "created"
	CreateExisting CreateKind = "existing"
	CreateConflict CreateKind = "conflict"
	CreateRejected CreateKind = "rejected"
)

type CreateResult struct {
	Kind   CreateKind
	Record *Record
}

type CommitKind string

const (
	CommitApplied  CommitKind = "applied"
	CommitReplayed CommitKind = "replayed"
	CommitConflict CommitKind = "conflict"
	CommitRejected CommitKind = "rejected"
)

type CommitResult struct {
	Kind    CommitKind
	Record  *Record
	Current *Record
}

type Repository interface {
	FindByID(context.Context, Scope, RequestID) (*Record, error)
	FindBySubmission(context.Context, Scope, SubmissionID) (*Record, error)
	Create(context.Context, Record) (CreateResult, error)
	Commit(context.Context, Scope, Transition) (CommitResult, error)
}
