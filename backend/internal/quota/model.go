package quota

import (
	"context"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	MaximumSafeInteger              int64 = 9_007_199_254_740_991
	MaximumRevision                 int64 = 2_147_483_647
	MaximumRequestBytes             int64 = 4_000_000
	MaximumCiphertextBytesPerObject int64 = 16_384
	MaximumReconciliationPageSize         = 100
)

type SegmentKind string

const (
	SegmentText SegmentKind = "text"
	SegmentLink SegmentKind = "link"
)

type DisplaySegment struct {
	Kind SegmentKind
	Text string
}

type BoundaryMeasurement struct {
	DisplayCharacters        int64
	SerializedPlaintextBytes int64
	CiphertextBytes          int64
	RequestBytes             int64
}

type BoundaryRejectionReason string

const (
	BoundaryDisplayCharacterLimit    BoundaryRejectionReason = "display-character-limit"
	BoundarySerializedPlaintextLimit BoundaryRejectionReason = "serialized-plaintext-limit"
	BoundaryCiphertextLimit          BoundaryRejectionReason = "ciphertext-limit"
	BoundaryRequestLimit             BoundaryRejectionReason = "request-limit"
)

type BoundaryEvaluation struct {
	Accepted bool
	Reasons  []BoundaryRejectionReason
}

type Usage struct {
	ActiveCards    int64
	PlaintextBytes int64
}

type ChangeKind string

const (
	ChangeCreate ChangeKind = "create"
	ChangeUpdate ChangeKind = "update"
	ChangeDelete ChangeKind = "delete"
)

type Change struct {
	Kind                  ChangeKind
	CurrentPlaintextBytes int64
	NextPlaintextBytes    int64
}

type ChangeRejectionReason string

const (
	ChangeInvalidUsage        ChangeRejectionReason = "invalid-usage"
	ChangeActiveCardLimit     ChangeRejectionReason = "active-card-limit"
	ChangeVaultPlaintextLimit ChangeRejectionReason = "vault-plaintext-limit"
)

type ChangeEvaluation struct {
	Accepted           bool
	Reason             ChangeRejectionReason
	CardDelta          int64
	PlaintextByteDelta int64
	Next               Usage
}

type Scope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type Snapshot struct {
	Scope
	Revision  Revision
	Committed Usage
	Reserved  Usage
	Effective Usage
	CreatedAt int64
	UpdatedAt int64
}

type ReservationStateKind string

const (
	ReservationReserved  ReservationStateKind = "reserved"
	ReservationCommitted ReservationStateKind = "committed"
	ReservationReleased  ReservationStateKind = "released"
)

type ReservationState struct {
	Kind          ReservationStateKind
	FinalizedAt   int64
	UsageRevision Revision
}

type Reservation struct {
	Scope
	ReservationID              ReservationID
	Fingerprint                Fingerprint
	CardID                     CardID
	ChangeKind                 ChangeKind
	CardDelta                  int64
	PlaintextByteDelta         int64
	ChargedCardDelta           int64
	ChargedPlaintextByteDelta  int64
	UsageRevisionAtReservation Revision
	State                      ReservationState
	CreatedAt                  int64
	ReconcileAfter             int64
}

type ReservationCommand struct {
	ReservationID  ReservationID
	Fingerprint    Fingerprint
	CardID         CardID
	Change         Change
	Limits         entitlement.PersonalVaultLimits
	RequestedAt    int64
	ReconcileAfter int64
}

type FinalizationOutcome string

const (
	FinalizationCommit  FinalizationOutcome = "commit"
	FinalizationRelease FinalizationOutcome = "release"
)

type FinalizationCommand struct {
	ReservationID ReservationID
	Fingerprint   Fingerprint
	Outcome       FinalizationOutcome
	Limits        entitlement.PersonalVaultLimits
	FinalizedAt   int64
}

type RejectionReason string

const (
	RejectionInvalidInput        RejectionReason = "invalid-input"
	RejectionIdempotencyKeyReuse RejectionReason = "idempotency-key-reuse"
	RejectionActiveCardLimit     RejectionReason = "active-card-limit"
	RejectionVaultPlaintextLimit RejectionReason = "vault-plaintext-limit"
	RejectionInvalidState        RejectionReason = "invalid-state"
	RejectionNotFound            RejectionReason = "not-found"
	RejectionCASConflict         RejectionReason = "cas-conflict"
)

type ReservationResultKind string

const (
	ReservationApplied  ReservationResultKind = "reserved"
	ReservationReplayed ReservationResultKind = "replayed"
	ReservationRejected ReservationResultKind = "rejected"
)

type ReservationResult struct {
	Kind        ReservationResultKind
	Reason      RejectionReason
	Reservation *Reservation
	Snapshot    *Snapshot
}

type FinalizationResultKind string

const (
	FinalizationCommitted FinalizationResultKind = "committed"
	FinalizationReleased  FinalizationResultKind = "released"
	FinalizationReplayed  FinalizationResultKind = "replayed"
	FinalizationRejected  FinalizationResultKind = "rejected"
)

type FinalizationResult struct {
	Kind        FinalizationResultKind
	Reason      RejectionReason
	Reservation *Reservation
	Snapshot    *Snapshot
}

type OpenResultKind string

const (
	LedgerOpened        OpenResultKind = "opened"
	LedgerOwnerMismatch OpenResultKind = "owner-mismatch"
)

type OpenResult struct {
	Kind   OpenResultKind
	Ledger Ledger
}

type Ledger interface {
	Snapshot(context.Context) (Snapshot, error)
	Reserve(context.Context, ReservationCommand) (ReservationResult, error)
	Finalize(context.Context, FinalizationCommand) (FinalizationResult, error)
	ListReconciliationCandidates(context.Context, int64, int) ([]Reservation, error)
	FindReservation(context.Context, ReservationID) (*Reservation, error)
}

type Directory interface {
	Open(context.Context, identity.VaultContext, int64) (OpenResult, error)
}
