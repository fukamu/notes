package operations

import (
	"context"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

type QuotaCommitCommand struct {
	AccountID     identity.AccountID
	VaultID       identity.VaultID
	ReservationID quota.ReservationID
	FinalizedAt   int64
}

type QuotaCommitEvidence struct {
	Owned       bool
	Reservation *quota.Reservation
	Receipt     *syncv2.Receipt
}

type QuotaCommitRepository interface {
	InspectQuotaCommit(context.Context, QuotaCommitCommand) (QuotaCommitEvidence, error)
	FinalizeQuotaCommit(
		context.Context,
		quota.Scope,
		quota.FinalizationCommand,
	) (quota.FinalizationResult, error)
}

type QuotaCommitPlanKind string

const (
	QuotaCommitPlanApply  QuotaCommitPlanKind = "apply"
	QuotaCommitPlanReplay QuotaCommitPlanKind = "replay"
	QuotaCommitPlanRefuse QuotaCommitPlanKind = "refuse"
)

type QuotaCommitRefusal string

const (
	QuotaCommitInvalidInput        QuotaCommitRefusal = "invalid-input"
	QuotaCommitOwnerMismatch       QuotaCommitRefusal = "owner-mismatch"
	QuotaCommitReservationNotFound QuotaCommitRefusal = "reservation-not-found"
	QuotaCommitEvidenceMissing     QuotaCommitRefusal = "evidence-missing"
	QuotaCommitEvidenceMismatch    QuotaCommitRefusal = "evidence-mismatch"
	QuotaCommitNotDue              QuotaCommitRefusal = "not-due"
	QuotaCommitAlreadyReleased     QuotaCommitRefusal = "already-released"
	QuotaCommitConflict            QuotaCommitRefusal = "conflict"
)

type QuotaCommitPlan struct {
	Kind        QuotaCommitPlanKind
	Reason      QuotaCommitRefusal
	Scope       quota.Scope
	Reservation *quota.Reservation
}

type QuotaCommitResultKind string

const (
	QuotaCommitCommitted QuotaCommitResultKind = "committed"
	QuotaCommitReplayed  QuotaCommitResultKind = "replayed"
	QuotaCommitRefused   QuotaCommitResultKind = "refused"
)

type QuotaCommitResult struct {
	Kind          QuotaCommitResultKind
	Reason        QuotaCommitRefusal
	ReservationID quota.ReservationID
	FinalizedAt   int64
}

type QuotaCommitService struct {
	repository QuotaCommitRepository
}

func NewQuotaCommitService(repository QuotaCommitRepository) (*QuotaCommitService, error) {
	if repository == nil {
		return nil, ErrQuotaReconciliationAudit
	}
	return &QuotaCommitService{repository: repository}, nil
}

func (service *QuotaCommitService) Commit(
	ctx context.Context,
	command QuotaCommitCommand,
) (QuotaCommitResult, error) {
	if service == nil || service.repository == nil || ctx == nil || ValidateQuotaCommitCommand(command) != nil {
		return QuotaCommitResult{}, ErrQuotaReconciliationAudit
	}
	evidence, err := service.repository.InspectQuotaCommit(ctx, command)
	if err != nil {
		return QuotaCommitResult{}, err
	}
	plan := PlanQuotaCommit(command, evidence)
	switch plan.Kind {
	case QuotaCommitPlanRefuse:
		return refusedQuotaCommit(command.ReservationID, plan.Reason), nil
	case QuotaCommitPlanReplay:
		if plan.Reservation == nil {
			return QuotaCommitResult{}, ErrQuotaReconciliationAudit
		}
		return QuotaCommitResult{
			Kind: QuotaCommitReplayed, ReservationID: command.ReservationID,
			FinalizedAt: plan.Reservation.State.FinalizedAt,
		}, nil
	case QuotaCommitPlanApply:
		if plan.Reservation == nil {
			return QuotaCommitResult{}, ErrQuotaReconciliationAudit
		}
	default:
		return QuotaCommitResult{}, ErrQuotaReconciliationAudit
	}
	finalized, err := service.repository.FinalizeQuotaCommit(ctx, plan.Scope, quota.FinalizationCommand{
		ReservationID: command.ReservationID,
		Fingerprint:   plan.Reservation.Fingerprint,
		Outcome:       quota.FinalizationCommit,
		Limits:        entitlement.PaidPersonalVaultLimits(),
		FinalizedAt:   command.FinalizedAt,
	})
	if err != nil {
		return QuotaCommitResult{}, err
	}
	switch finalized.Kind {
	case quota.FinalizationCommitted, quota.FinalizationReplayed:
		if finalized.Reservation == nil || !validCommittedReservation(
			*finalized.Reservation, plan.Scope, command.ReservationID,
		) {
			return QuotaCommitResult{}, ErrQuotaReconciliationAudit
		}
		kind := QuotaCommitCommitted
		if finalized.Kind == quota.FinalizationReplayed {
			kind = QuotaCommitReplayed
		}
		return QuotaCommitResult{
			Kind: kind, ReservationID: command.ReservationID,
			FinalizedAt: finalized.Reservation.State.FinalizedAt,
		}, nil
	case quota.FinalizationRejected:
		return refusedQuotaCommit(command.ReservationID, QuotaCommitConflict), nil
	default:
		return QuotaCommitResult{}, ErrQuotaReconciliationAudit
	}
}

func PlanQuotaCommit(command QuotaCommitCommand, evidence QuotaCommitEvidence) QuotaCommitPlan {
	if ValidateQuotaCommitCommand(command) != nil {
		return refusedQuotaCommitPlan(QuotaCommitInvalidInput)
	}
	scope := quota.Scope{AccountID: command.AccountID, VaultID: command.VaultID}
	if !evidence.Owned {
		if evidence.Reservation != nil || evidence.Receipt != nil {
			return refusedQuotaCommitPlan(QuotaCommitInvalidInput)
		}
		return refusedQuotaCommitPlan(QuotaCommitOwnerMismatch)
	}
	if evidence.Reservation == nil {
		return refusedQuotaCommitPlan(QuotaCommitReservationNotFound)
	}
	reservation := *evidence.Reservation
	if !quota.ValidReservation(reservation) || reservation.Scope != scope ||
		reservation.ReservationID != command.ReservationID {
		return refusedQuotaCommitPlan(QuotaCommitInvalidInput)
	}
	if evidence.Receipt == nil {
		return refusedQuotaCommitPlan(QuotaCommitEvidenceMissing)
	}
	if !validCommitReceipt(*evidence.Receipt) || !matchingCommitEvidence(reservation, *evidence.Receipt) {
		return refusedQuotaCommitPlan(QuotaCommitEvidenceMismatch)
	}
	switch reservation.State.Kind {
	case quota.ReservationReleased:
		return refusedQuotaCommitPlan(QuotaCommitAlreadyReleased)
	case quota.ReservationCommitted:
		copyOfReservation := reservation
		return QuotaCommitPlan{
			Kind: QuotaCommitPlanReplay, Scope: scope, Reservation: &copyOfReservation,
		}
	case quota.ReservationReserved:
		if command.FinalizedAt < reservation.ReconcileAfter {
			return refusedQuotaCommitPlan(QuotaCommitNotDue)
		}
		copyOfReservation := reservation
		return QuotaCommitPlan{
			Kind: QuotaCommitPlanApply, Scope: scope, Reservation: &copyOfReservation,
		}
	default:
		return refusedQuotaCommitPlan(QuotaCommitInvalidInput)
	}
}

func ValidateQuotaCommitCommand(command QuotaCommitCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrQuotaReconciliationAudit
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil {
		return ErrQuotaReconciliationAudit
	}
	if _, err := quota.ParseReservationID(string(command.ReservationID)); err != nil || !validTimestamp(command.FinalizedAt) {
		return ErrQuotaReconciliationAudit
	}
	return nil
}

func validCommitReceipt(receipt syncv2.Receipt) bool {
	_, mutationErr := syncv2.ParseMutationID(string(receipt.MutationID))
	_, fingerprintErr := syncv2.ParseFingerprint(string(receipt.Fingerprint))
	_, cardErr := syncv2.ParseCardID(string(receipt.CardID))
	_, revisionErr := syncv2.ParseRevision(int64(receipt.AppliedRevision))
	return mutationErr == nil && fingerprintErr == nil && cardErr == nil && revisionErr == nil &&
		validTimestamp(receipt.CommittedAt)
}

func matchingCommitEvidence(reservation quota.Reservation, receipt syncv2.Receipt) bool {
	return string(receipt.MutationID) == string(reservation.ReservationID) &&
		string(receipt.Fingerprint) == string(reservation.Fingerprint) &&
		string(receipt.CardID) == string(reservation.CardID) &&
		receipt.CommittedAt == reservation.CreatedAt
}

func validCommittedReservation(
	reservation quota.Reservation,
	scope quota.Scope,
	reservationID quota.ReservationID,
) bool {
	return quota.ValidReservation(reservation) && reservation.Scope == scope &&
		reservation.ReservationID == reservationID && reservation.State.Kind == quota.ReservationCommitted
}

func refusedQuotaCommitPlan(reason QuotaCommitRefusal) QuotaCommitPlan {
	return QuotaCommitPlan{Kind: QuotaCommitPlanRefuse, Reason: reason}
}

func refusedQuotaCommit(reservationID quota.ReservationID, reason QuotaCommitRefusal) QuotaCommitResult {
	return QuotaCommitResult{Kind: QuotaCommitRefused, Reason: reason, ReservationID: reservationID}
}
