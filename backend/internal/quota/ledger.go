package quota

import "github.com/fukamu/notes/backend/internal/identity"

type ReservationPlanKind string

const (
	ReservationPlanApply    ReservationPlanKind = "apply"
	ReservationPlanReplay   ReservationPlanKind = "replay"
	ReservationPlanRejected ReservationPlanKind = "rejected"
)

type ReservationPlan struct {
	Kind        ReservationPlanKind
	Reason      RejectionReason
	Current     Snapshot
	Reservation Reservation
}

type FinalizationPlanKind string

const (
	FinalizationPlanApply    FinalizationPlanKind = "apply"
	FinalizationPlanReplay   FinalizationPlanKind = "replay"
	FinalizationPlanRejected FinalizationPlanKind = "rejected"
)

type FinalizationPlan struct {
	Kind        FinalizationPlanKind
	Reason      RejectionReason
	Current     Snapshot
	Next        Snapshot
	Reservation Reservation
}

func PlanReservation(
	scope Scope,
	current Snapshot,
	existing *Reservation,
	command ReservationCommand,
) ReservationPlan {
	if !ValidSnapshot(current) || !sameScope(scope, current.Scope) ||
		!validReservationCommand(command) {
		return ReservationPlan{Kind: ReservationPlanRejected, Reason: RejectionInvalidInput}
	}
	if existing != nil {
		if !sameScope(scope, existing.Scope) || !ValidReservation(*existing) ||
			existing.ReservationID != command.ReservationID {
			return ReservationPlan{Kind: ReservationPlanRejected, Reason: RejectionInvalidInput}
		}
		if existing.Fingerprint != command.Fingerprint {
			return ReservationPlan{Kind: ReservationPlanRejected, Reason: RejectionIdempotencyKeyReuse}
		}
		return ReservationPlan{Kind: ReservationPlanReplay, Reservation: *existing}
	}
	evaluated := EvaluateChange(current.Effective, command.Change, command.Limits)
	if !evaluated.Accepted {
		reason := RejectionInvalidInput
		if evaluated.Reason == ChangeActiveCardLimit {
			reason = RejectionActiveCardLimit
		} else if evaluated.Reason == ChangeVaultPlaintextLimit {
			reason = RejectionVaultPlaintextLimit
		}
		return ReservationPlan{Kind: ReservationPlanRejected, Reason: reason}
	}
	chargedCardDelta := int64(0)
	if evaluated.CardDelta > 0 {
		chargedCardDelta = 1
	}
	chargedBytes := evaluated.PlaintextByteDelta
	if chargedBytes < 0 {
		chargedBytes = 0
	}
	reservation := Reservation{
		Scope: scope, ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		CardID: command.CardID, ChangeKind: command.Change.Kind,
		CardDelta: evaluated.CardDelta, PlaintextByteDelta: evaluated.PlaintextByteDelta,
		ChargedCardDelta: chargedCardDelta, ChargedPlaintextByteDelta: chargedBytes,
		UsageRevisionAtReservation: current.Revision,
		State:                      ReservationState{Kind: ReservationReserved},
		CreatedAt:                  command.RequestedAt, ReconcileAfter: command.ReconcileAfter,
	}
	if !ValidReservation(reservation) {
		return ReservationPlan{Kind: ReservationPlanRejected, Reason: RejectionInvalidInput}
	}
	return ReservationPlan{Kind: ReservationPlanApply, Current: current, Reservation: reservation}
}

func PlanFinalization(
	scope Scope,
	current Snapshot,
	reservation Reservation,
	command FinalizationCommand,
) FinalizationPlan {
	if !sameScope(scope, current.Scope) || !sameScope(scope, reservation.Scope) ||
		reservation.ReservationID != command.ReservationID || !ValidSnapshot(current) ||
		!ValidReservation(reservation) || !validFinalizationCommand(command) ||
		command.FinalizedAt < reservation.CreatedAt {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidInput}
	}
	if reservation.Fingerprint != command.Fingerprint {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionIdempotencyKeyReuse}
	}
	if reservation.State.Kind != ReservationReserved {
		expected := ReservationCommitted
		if command.Outcome == FinalizationRelease {
			expected = ReservationReleased
		}
		if reservation.State.Kind == expected {
			return FinalizationPlan{Kind: FinalizationPlanReplay, Reservation: reservation}
		}
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidState}
	}
	if int64(current.Revision) == MaximumRevision {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidInput}
	}
	committedDeltaCards, committedDeltaBytes := int64(0), int64(0)
	if command.Outcome == FinalizationCommit {
		committedDeltaCards = reservation.CardDelta
		committedDeltaBytes = reservation.PlaintextByteDelta
	}
	committed, committedOK := addUsage(current.Committed, committedDeltaCards, committedDeltaBytes)
	reserved, reservedOK := addUsage(
		current.Reserved, -reservation.ChargedCardDelta, -reservation.ChargedPlaintextByteDelta,
	)
	if !committedOK || !reservedOK {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidInput}
	}
	effective, effectiveOK := addUsage(committed, reserved.ActiveCards, reserved.PlaintextBytes)
	if !effectiveOK || effective.ActiveCards > command.Limits.ActiveCards ||
		effective.PlaintextBytes > command.Limits.PlaintextBytesPerVault {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidInput}
	}
	nextRevision := Revision(int64(current.Revision) + 1)
	state := ReservationCommitted
	if command.Outcome == FinalizationRelease {
		state = ReservationReleased
	}
	reservation.State = ReservationState{
		Kind: state, FinalizedAt: command.FinalizedAt, UsageRevision: nextRevision,
	}
	next := Snapshot{
		Scope: scope, Revision: nextRevision, Committed: committed, Reserved: reserved,
		Effective: effective, CreatedAt: current.CreatedAt, UpdatedAt: command.FinalizedAt,
	}
	if !ValidSnapshot(next) || !ValidReservation(reservation) {
		return FinalizationPlan{Kind: FinalizationPlanRejected, Reason: RejectionInvalidInput}
	}
	return FinalizationPlan{
		Kind: FinalizationPlanApply, Current: current, Next: next, Reservation: reservation,
	}
}

func EmptySnapshot(scope Scope, initializedAt int64) (Snapshot, bool) {
	if !validScope(scope) || !validTimestamp(initializedAt) {
		return Snapshot{}, false
	}
	return Snapshot{
		Scope: scope, Revision: 1, Committed: Usage{}, Reserved: Usage{}, Effective: Usage{},
		CreatedAt: initializedAt, UpdatedAt: initializedAt,
	}, true
}

func ValidSnapshot(snapshot Snapshot) bool {
	if !validScope(snapshot.Scope) || !validRevision(snapshot.Revision) ||
		!validUsage(snapshot.Committed) || !validUsage(snapshot.Reserved) ||
		!validUsage(snapshot.Effective) || !validTimestamp(snapshot.CreatedAt) ||
		!validTimestamp(snapshot.UpdatedAt) || snapshot.CreatedAt > snapshot.UpdatedAt {
		return false
	}
	effective, ok := addUsage(
		snapshot.Committed, snapshot.Reserved.ActiveCards, snapshot.Reserved.PlaintextBytes,
	)
	return ok && effective == snapshot.Effective
}

func ValidReservation(reservation Reservation) bool {
	if !validScope(reservation.Scope) || !validReservationID(reservation.ReservationID) ||
		!validFingerprint(reservation.Fingerprint) || !validCardID(reservation.CardID) ||
		!validRevision(reservation.UsageRevisionAtReservation) ||
		!validTimestamp(reservation.CreatedAt) || !validTimestamp(reservation.ReconcileAfter) ||
		reservation.ReconcileAfter <= reservation.CreatedAt ||
		reservation.PlaintextByteDelta < -MaximumSafeInteger ||
		reservation.PlaintextByteDelta > MaximumSafeInteger {
		return false
	}
	validDelta := reservation.ChangeKind == ChangeCreate && reservation.CardDelta == 1 &&
		reservation.PlaintextByteDelta >= 0 && reservation.ChargedCardDelta == 1 &&
		reservation.ChargedPlaintextByteDelta == reservation.PlaintextByteDelta ||
		reservation.ChangeKind == ChangeUpdate && reservation.CardDelta == 0 &&
			reservation.ChargedCardDelta == 0 && reservation.ChargedPlaintextByteDelta == maxZero(reservation.PlaintextByteDelta) ||
		reservation.ChangeKind == ChangeDelete && reservation.CardDelta == -1 &&
			reservation.PlaintextByteDelta <= 0 && reservation.ChargedCardDelta == 0 &&
			reservation.ChargedPlaintextByteDelta == 0
	if !validDelta {
		return false
	}
	switch reservation.State.Kind {
	case ReservationReserved:
		return reservation.State.FinalizedAt == 0 && reservation.State.UsageRevision == 0
	case ReservationCommitted, ReservationReleased:
		return validTimestamp(reservation.State.FinalizedAt) &&
			reservation.State.FinalizedAt >= reservation.CreatedAt &&
			reservation.State.UsageRevision > reservation.UsageRevisionAtReservation &&
			validRevision(reservation.State.UsageRevision)
	default:
		return false
	}
}

func validReservationCommand(command ReservationCommand) bool {
	return validReservationID(command.ReservationID) && validFingerprint(command.Fingerprint) &&
		validCardID(command.CardID) && validChange(command.Change) && validLimits(command.Limits) &&
		validTimestamp(command.RequestedAt) && validTimestamp(command.ReconcileAfter) &&
		command.ReconcileAfter > command.RequestedAt
}

func validFinalizationCommand(command FinalizationCommand) bool {
	return validReservationID(command.ReservationID) && validFingerprint(command.Fingerprint) &&
		(command.Outcome == FinalizationCommit || command.Outcome == FinalizationRelease) &&
		validLimits(command.Limits) && validTimestamp(command.FinalizedAt)
}

func validScope(scope Scope) bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

func sameScope(left, right Scope) bool {
	return left.AccountID == right.AccountID && left.VaultID == right.VaultID
}

func validReservationID(value ReservationID) bool {
	_, err := ParseReservationID(string(value))
	return err == nil
}

func validCardID(value CardID) bool {
	_, err := ParseCardID(string(value))
	return err == nil
}

func validFingerprint(value Fingerprint) bool {
	_, err := ParseFingerprint(string(value))
	return err == nil
}

func validRevision(value Revision) bool {
	_, err := ParseRevision(int64(value))
	return err == nil
}

func addUsage(current Usage, cards, bytes int64) (Usage, bool) {
	nextCards, cardsOK := safeAdd(current.ActiveCards, cards)
	nextBytes, bytesOK := safeAdd(current.PlaintextBytes, bytes)
	return Usage{ActiveCards: nextCards, PlaintextBytes: nextBytes}, cardsOK && bytesOK
}

func maxZero(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}
