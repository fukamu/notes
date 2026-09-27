package quota

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestPlanReservationEnforcesReplayAndPositiveCharges(t *testing.T) {
	scope := testScope(t)
	current, ok := EmptySnapshot(scope, 1_000)
	if !ok {
		t.Fatal("empty snapshot rejected")
	}
	command := testReservationCommand(t, 1, 10, 2_000, 3_000)
	plan := PlanReservation(scope, current, nil, command)
	if plan.Kind != ReservationPlanApply || plan.Reservation.CardDelta != 1 ||
		plan.Reservation.ChargedCardDelta != 1 ||
		plan.Reservation.PlaintextByteDelta != 10 ||
		plan.Reservation.ChargedPlaintextByteDelta != 10 ||
		plan.Reservation.UsageRevisionAtReservation != 1 {
		t.Fatalf("reservation plan = %#v", plan)
	}
	replay := PlanReservation(scope, current, &plan.Reservation, command)
	if replay.Kind != ReservationPlanReplay {
		t.Fatalf("replay = %#v", replay)
	}
	reused := command
	reused.Fingerprint = testFingerprint(t, "different")
	conflict := PlanReservation(scope, current, &plan.Reservation, reused)
	if conflict.Kind != ReservationPlanRejected || conflict.Reason != RejectionIdempotencyKeyReuse {
		t.Fatalf("key reuse = %#v", conflict)
	}
}

func TestPlanReservationChargesNoCapacityForDecreaseOrDelete(t *testing.T) {
	scope := testScope(t)
	current := Snapshot{
		Scope: scope, Revision: 2,
		Committed: Usage{ActiveCards: 1, PlaintextBytes: 10},
		Effective: Usage{ActiveCards: 1, PlaintextBytes: 10},
		CreatedAt: 1_000, UpdatedAt: 2_000,
	}
	decrease := testReservationCommand(t, 2, 0, 3_000, 4_000)
	decrease.Change = Change{Kind: ChangeUpdate, CurrentPlaintextBytes: 10, NextPlaintextBytes: 4}
	decreasePlan := PlanReservation(scope, current, nil, decrease)
	if decreasePlan.Kind != ReservationPlanApply || decreasePlan.Reservation.PlaintextByteDelta != -6 ||
		decreasePlan.Reservation.ChargedPlaintextByteDelta != 0 {
		t.Fatalf("decrease reservation = %#v", decreasePlan)
	}
	deletion := testReservationCommand(t, 3, 0, 3_001, 4_001)
	deletion.Change = Change{Kind: ChangeDelete, CurrentPlaintextBytes: 10}
	deletePlan := PlanReservation(scope, current, nil, deletion)
	if deletePlan.Kind != ReservationPlanApply || deletePlan.Reservation.CardDelta != -1 ||
		deletePlan.Reservation.ChargedCardDelta != 0 ||
		deletePlan.Reservation.ChargedPlaintextByteDelta != 0 {
		t.Fatalf("delete reservation = %#v", deletePlan)
	}
}

func TestPlanFinalizationCommitsExactlyOnceAndSupportsRelease(t *testing.T) {
	scope := testScope(t)
	command := testReservationCommand(t, 4, 10, 2_000, 3_000)
	base, _ := EmptySnapshot(scope, 1_000)
	reservedPlan := PlanReservation(scope, base, nil, command)
	current := base
	current.Reserved = Usage{ActiveCards: 1, PlaintextBytes: 10}
	current.Effective = Usage{ActiveCards: 1, PlaintextBytes: 10}
	finalization := FinalizationCommand{
		ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		Outcome: FinalizationCommit, Limits: command.Limits, FinalizedAt: 4_000,
	}
	committed := PlanFinalization(scope, current, reservedPlan.Reservation, finalization)
	if committed.Kind != FinalizationPlanApply || committed.Next.Revision != 2 ||
		committed.Next.Committed != (Usage{ActiveCards: 1, PlaintextBytes: 10}) ||
		committed.Next.Reserved != (Usage{}) ||
		committed.Reservation.State.Kind != ReservationCommitted {
		t.Fatalf("commit = %#v", committed)
	}
	replay := PlanFinalization(scope, committed.Next, committed.Reservation, finalization)
	if replay.Kind != FinalizationPlanReplay {
		t.Fatalf("commit replay = %#v", replay)
	}
	opposite := finalization
	opposite.Outcome = FinalizationRelease
	invalid := PlanFinalization(scope, committed.Next, committed.Reservation, opposite)
	if invalid.Kind != FinalizationPlanRejected || invalid.Reason != RejectionInvalidState {
		t.Fatalf("opposite replay = %#v", invalid)
	}

	releaseCommand := testReservationCommand(t, 5, 7, 5_000, 6_000)
	releasePlan := PlanReservation(scope, committed.Next, nil, releaseCommand)
	withPending := committed.Next
	withPending.Reserved = Usage{ActiveCards: 1, PlaintextBytes: 7}
	withPending.Effective = Usage{ActiveCards: 2, PlaintextBytes: 17}
	released := PlanFinalization(scope, withPending, releasePlan.Reservation, FinalizationCommand{
		ReservationID: releaseCommand.ReservationID, Fingerprint: releaseCommand.Fingerprint,
		Outcome: FinalizationRelease, Limits: releaseCommand.Limits, FinalizedAt: 7_000,
	})
	if released.Kind != FinalizationPlanApply || released.Next.Committed != committed.Next.Committed ||
		released.Next.Reserved != (Usage{}) || released.Reservation.State.Kind != ReservationReleased {
		t.Fatalf("release = %#v", released)
	}
}

func TestPlanFinalizationAppliesDecreaseOnlyAfterCommit(t *testing.T) {
	scope := testScope(t)
	current := Snapshot{
		Scope: scope, Revision: 2,
		Committed: Usage{ActiveCards: 1, PlaintextBytes: 10},
		Effective: Usage{ActiveCards: 1, PlaintextBytes: 10},
		CreatedAt: 1_000, UpdatedAt: 2_000,
	}
	command := testReservationCommand(t, 6, 0, 3_000, 4_000)
	command.Change = Change{Kind: ChangeUpdate, CurrentPlaintextBytes: 10, NextPlaintextBytes: 4}
	reservation := PlanReservation(scope, current, nil, command)
	if reservation.Kind != ReservationPlanApply {
		t.Fatalf("reserve decrease = %#v", reservation)
	}
	finalized := PlanFinalization(scope, current, reservation.Reservation, FinalizationCommand{
		ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		Outcome: FinalizationCommit, Limits: command.Limits, FinalizedAt: 5_000,
	})
	if finalized.Kind != FinalizationPlanApply ||
		finalized.Next.Committed != (Usage{ActiveCards: 1, PlaintextBytes: 4}) {
		t.Fatalf("finalize decrease = %#v", finalized)
	}
}

func TestPlansRejectMalformedAndOverflowingState(t *testing.T) {
	scope := testScope(t)
	current, _ := EmptySnapshot(scope, 1_000)
	current.Effective.ActiveCards = 1
	command := testReservationCommand(t, 7, 1, 2_000, 3_000)
	if plan := PlanReservation(scope, current, nil, command); plan.Kind != ReservationPlanRejected ||
		plan.Reason != RejectionInvalidInput {
		t.Fatalf("malformed snapshot = %#v", plan)
	}
	valid, _ := EmptySnapshot(scope, 1_000)
	valid.Revision = Revision(MaximumRevision)
	reservation := PlanReservation(scope, valid, nil, command)
	withPending := valid
	withPending.Reserved = Usage{ActiveCards: 1, PlaintextBytes: 1}
	withPending.Effective = Usage{ActiveCards: 1, PlaintextBytes: 1}
	finalized := PlanFinalization(scope, withPending, reservation.Reservation, FinalizationCommand{
		ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		Outcome: FinalizationCommit, Limits: command.Limits, FinalizedAt: 4_000,
	})
	if finalized.Kind != FinalizationPlanRejected || finalized.Reason != RejectionInvalidInput {
		t.Fatalf("revision overflow = %#v", finalized)
	}
}

func testScope(t *testing.T) Scope {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if err != nil {
		t.Fatal(err)
	}
	return Scope{AccountID: accountID, VaultID: vaultID}
}

func testReservationCommand(
	t *testing.T,
	suffix int,
	bytes int64,
	requestedAt int64,
	reconcileAfter int64,
) ReservationCommand {
	t.Helper()
	reservationID, err := ParseReservationID("01991f20-61d2-7000-8000-000000000" + testThreeDigits(suffix))
	if err != nil {
		t.Fatal(err)
	}
	cardID, err := ParseCardID("01991f20-61d2-7000-8000-000000001" + testThreeDigits(suffix))
	if err != nil {
		t.Fatal(err)
	}
	return ReservationCommand{
		ReservationID: reservationID, Fingerprint: testFingerprint(t, string(reservationID)), CardID: cardID,
		Change: Change{Kind: ChangeCreate, NextPlaintextBytes: bytes},
		Limits: entitlement.PaidPersonalVaultLimits(), RequestedAt: requestedAt,
		ReconcileAfter: reconcileAfter,
	}
}

func testFingerprint(t *testing.T, input string) Fingerprint {
	t.Helper()
	digest := sha256.Sum256([]byte(input))
	value, err := ParseFingerprint(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func testThreeDigits(value int) string {
	return string([]byte{'0' + byte(value/100%10), '0' + byte(value/10%10), '0' + byte(value%10)})
}
