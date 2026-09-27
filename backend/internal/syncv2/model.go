package syncv2

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	MaximumSafeInteger      int64 = 9_007_199_254_740_991
	MaximumRevision         int64 = 2_147_483_647
	MaximumDisplayID        int64 = 2_147_483_647
	MaximumPageSize               = 500
	MaximumConflictIDs            = 500
	MaximumConflictsPerCard       = 100_000
)

type Scope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type State struct {
	NextDisplayID int64
	NextSequence  Sequence
}

type Receipt struct {
	MutationID      MutationID
	Fingerprint     Fingerprint
	CardID          CardID
	AppliedRevision Revision
	CommittedAt     int64
}

type CardHead struct {
	CardID            CardID
	OfficialDisplayID int64
	Revision          Revision
	UpdatedAt         int64
}

type ConflictHead struct {
	ConflictID     ConflictID
	CardID         CardID
	ServerRevision Revision
	CreatedAt      int64
}

type ChangeKind string

const (
	ChangeCardUpsert        ChangeKind = "card-upsert"
	ChangeCardTombstone     ChangeKind = "card-tombstone"
	ChangeConflictUpsert    ChangeKind = "conflict-upsert"
	ChangeConflictTombstone ChangeKind = "conflict-tombstone"
)

// Change is a validated tagged value. Fields not belonging to Kind stay zero.
type Change struct {
	Kind              ChangeKind
	Sequence          Sequence
	CardID            CardID
	ConflictID        ConflictID
	Revision          Revision
	OfficialDisplayID int64
	OccurredAt        int64
}

type CommandKind string

const (
	CommandCardUpsert       CommandKind = "card-upsert"
	CommandConflictUpsert   CommandKind = "conflict-upsert"
	CommandResolveConflicts CommandKind = "resolve-conflicts"
	CommandCardDelete       CommandKind = "card-delete"
)

// CommitCommand is decoded at the application boundary before reaching the
// planner. Kind determines which state-specific fields are meaningful.
type CommitCommand struct {
	Kind             CommandKind
	MutationID       MutationID
	Fingerprint      Fingerprint
	CommittedAt      int64
	CardID           CardID
	ConflictID       ConflictID
	ConflictIDs      []ConflictID
	ExpectedRevision *Revision
	NextRevision     Revision
	ServerRevision   Revision
	OccurredAt       int64
}

type Snapshot struct {
	State             State
	ExistingReceipt   *Receipt
	Card              *CardHead
	SelectedConflicts []ConflictHead
	AllCardConflicts  []ConflictHead
}

type RejectionReason string

const (
	ReasonIdempotencyKeyReuse  RejectionReason = "idempotency-key-reuse"
	ReasonUnexpectedCard       RejectionReason = "unexpected-card"
	ReasonMissingCard          RejectionReason = "missing-card"
	ReasonStaleRevision        RejectionReason = "stale-revision"
	ReasonInvalidNextRevision  RejectionReason = "invalid-next-revision"
	ReasonUnexpectedConflict   RejectionReason = "unexpected-conflict"
	ReasonMissingConflict      RejectionReason = "missing-conflict"
	ReasonConflictCardMismatch RejectionReason = "conflict-card-mismatch"
	ReasonInvalidTimeline      RejectionReason = "invalid-timeline"
	ReasonInvalidState         RejectionReason = "invalid-state"
	ReasonCASConflict          RejectionReason = "cas-conflict"
)

type PlanKind string

const (
	PlanCommit   PlanKind = "commit"
	PlanReplay   PlanKind = "replayed"
	PlanRejected PlanKind = "not-applied"
)

type CommitPlan struct {
	Kind              PlanKind
	Reason            RejectionReason
	Receipt           Receipt
	ExpectedState     State
	NextState         State
	OfficialDisplayID int64
	Changes           []Change
}

type CommitResultKind string

const (
	CommitApplied  CommitResultKind = "applied"
	CommitReplayed CommitResultKind = "replayed"
	CommitRejected CommitResultKind = "not-applied"
)

type CommitResult struct {
	Kind    CommitResultKind
	Reason  RejectionReason
	Receipt *Receipt
}

type PageKind string

const (
	PageMore     PageKind = "more"
	PageComplete PageKind = "complete"
)

type Page struct {
	HighWatermark Sequence
	Changes       []Change
	Kind          PageKind
	AfterSequence Sequence
}

type OpenResultKind string

const (
	JournalOpened        OpenResultKind = "opened"
	JournalOwnerMismatch OpenResultKind = "owner-mismatch"
)

type OpenResult struct {
	Kind       OpenResultKind
	Repository Repository
}

type Repository interface {
	FindCard(context.Context, CardID) (*CardHead, error)
	FindReceipt(context.Context, MutationID) (*Receipt, error)
	Commit(context.Context, CommitCommand) (CommitResult, error)
	ReadPage(context.Context, Sequence, *Sequence, int) (Page, error)
}

type Directory interface {
	Open(context.Context, identity.VaultContext) (OpenResult, error)
}
