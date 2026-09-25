package operations

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

func TestPlanQuotaCommitRequiresExactDurableEvidence(t *testing.T) {
	t.Parallel()
	command, evidence := quotaCommitFixture(t)
	plan := PlanQuotaCommit(command, evidence)
	if plan.Kind != QuotaCommitPlanApply || plan.Reservation == nil ||
		plan.Reservation.ReservationID != command.ReservationID {
		t.Fatalf("plan = %#v", plan)
	}
	evidence.Reservation.Fingerprint = quotaCommitFingerprint(t, "different")
	if plan := PlanQuotaCommit(command, evidence); plan.Kind != QuotaCommitPlanRefuse ||
		plan.Reason != QuotaCommitEvidenceMismatch {
		t.Fatalf("mismatch plan = %#v", plan)
	}
	differentFingerprint := syncv2.Fingerprint(quotaCommitFingerprint(t, "different-receipt"))
	mismatches := map[string]func(*syncv2.Receipt){
		"mutation": func(receipt *syncv2.Receipt) {
			receipt.MutationID, _ = syncv2.ParseMutationID("01991f20-61d2-7000-8000-000000000402")
		},
		"fingerprint": func(receipt *syncv2.Receipt) {
			receipt.Fingerprint = differentFingerprint
		},
		"card": func(receipt *syncv2.Receipt) {
			receipt.CardID, _ = syncv2.ParseCardID("01991f20-61d2-7000-8000-000000000502")
		},
		"timestamp": func(receipt *syncv2.Receipt) {
			receipt.CommittedAt++
		},
	}
	for name, update := range mismatches {
		name, update := name, update
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			command, evidence := quotaCommitFixture(t)
			update(evidence.Receipt)
			if plan := PlanQuotaCommit(command, evidence); plan.Kind != QuotaCommitPlanRefuse ||
				plan.Reason != QuotaCommitEvidenceMismatch {
				t.Fatalf("mismatch plan = %#v", plan)
			}
		})
	}
}

func TestPlanQuotaCommitRefusesUnsafeAlternatives(t *testing.T) {
	t.Parallel()
	validCommand, validEvidence := quotaCommitFixture(t)
	tests := []struct {
		name     string
		command  QuotaCommitCommand
		evidence QuotaCommitEvidence
		reason   QuotaCommitRefusal
	}{
		{
			name: "invalid command", command: withQuotaCommitCommand(validCommand, func(value *QuotaCommitCommand) { value.FinalizedAt = -1 }),
			evidence: validEvidence, reason: QuotaCommitInvalidInput,
		},
		{name: "owner mismatch", command: validCommand, evidence: QuotaCommitEvidence{}, reason: QuotaCommitOwnerMismatch},
		{
			name: "data for absent owner", command: validCommand,
			evidence: QuotaCommitEvidence{Reservation: validEvidence.Reservation}, reason: QuotaCommitInvalidInput,
		},
		{name: "reservation missing", command: validCommand, evidence: QuotaCommitEvidence{Owned: true}, reason: QuotaCommitReservationNotFound},
		{
			name: "receipt missing", command: validCommand,
			evidence: QuotaCommitEvidence{Owned: true, Reservation: validEvidence.Reservation}, reason: QuotaCommitEvidenceMissing,
		},
		{
			name:     "not due",
			command:  withQuotaCommitCommand(validCommand, func(value *QuotaCommitCommand) { value.FinalizedAt = 3_999 }),
			evidence: validEvidence, reason: QuotaCommitNotDue,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			plan := PlanQuotaCommit(test.command, test.evidence)
			if plan.Kind != QuotaCommitPlanRefuse || plan.Reason != test.reason {
				t.Fatalf("plan = %#v", plan)
			}
		})
	}
}

func TestPlanQuotaCommitReplaysCommittedAndRefusesReleased(t *testing.T) {
	t.Parallel()
	command, evidence := quotaCommitFixture(t)
	committed := *evidence.Reservation
	committed.State = quota.ReservationState{
		Kind: quota.ReservationCommitted, FinalizedAt: 5_000, UsageRevision: 2,
	}
	evidence.Reservation = &committed
	if plan := PlanQuotaCommit(command, evidence); plan.Kind != QuotaCommitPlanReplay {
		t.Fatalf("replay plan = %#v", plan)
	}
	released := committed
	released.State.Kind = quota.ReservationReleased
	evidence.Reservation = &released
	if plan := PlanQuotaCommit(command, evidence); plan.Kind != QuotaCommitPlanRefuse ||
		plan.Reason != QuotaCommitAlreadyReleased {
		t.Fatalf("released plan = %#v", plan)
	}
}

func TestQuotaCommitServiceAppliesAndMapsReplayConflictAndFailures(t *testing.T) {
	t.Parallel()
	command, evidence := quotaCommitFixture(t)
	committed := *evidence.Reservation
	committed.State = quota.ReservationState{
		Kind: quota.ReservationCommitted, FinalizedAt: command.FinalizedAt, UsageRevision: 2,
	}
	tests := []struct {
		name        string
		finalized   quota.FinalizationResult
		finalizeErr error
		wantKind    QuotaCommitResultKind
		wantReason  QuotaCommitRefusal
		wantErr     error
	}{
		{
			name: "committed", finalized: quota.FinalizationResult{
				Kind: quota.FinalizationCommitted, Reservation: &committed,
			}, wantKind: QuotaCommitCommitted,
		},
		{
			name: "replayed", finalized: quota.FinalizationResult{
				Kind: quota.FinalizationReplayed, Reservation: &committed,
			}, wantKind: QuotaCommitReplayed,
		},
		{
			name: "conflict", finalized: quota.FinalizationResult{
				Kind: quota.FinalizationRejected, Reason: quota.RejectionCASConflict,
			}, wantKind: QuotaCommitRefused, wantReason: QuotaCommitConflict,
		},
		{
			name: "dependency", finalizeErr: errors.New("PRIVATE-DB-FAILURE"),
			wantErr: errors.New("PRIVATE-DB-FAILURE"),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &quotaCommitRepository{
				evidence: evidence, finalized: test.finalized, finalizeErr: test.finalizeErr,
			}
			service, _ := NewQuotaCommitService(repository)
			result, err := service.Commit(context.Background(), command)
			if test.wantErr != nil {
				if err == nil || err.Error() != test.wantErr.Error() {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil || result.Kind != test.wantKind || result.Reason != test.wantReason ||
				repository.finalization.Outcome != quota.FinalizationCommit ||
				repository.finalization.Limits != entitlement.PaidPersonalVaultLimits() {
				t.Fatalf("result = %#v, command = %#v, error = %v", result, repository.finalization, err)
			}
		})
	}
}

func TestQuotaCommitServiceDoesNotWriteOnRefusalOrReplay(t *testing.T) {
	t.Parallel()
	command, evidence := quotaCommitFixture(t)
	service, _ := NewQuotaCommitService(&quotaCommitRepository{evidence: QuotaCommitEvidence{Owned: true}})
	result, err := service.Commit(context.Background(), command)
	if err != nil || result.Kind != QuotaCommitRefused || result.Reason != QuotaCommitReservationNotFound {
		t.Fatalf("refused result = %#v, %v", result, err)
	}
	committed := *evidence.Reservation
	committed.State = quota.ReservationState{Kind: quota.ReservationCommitted, FinalizedAt: 5_000, UsageRevision: 2}
	repository := &quotaCommitRepository{evidence: QuotaCommitEvidence{
		Owned: true, Reservation: &committed, Receipt: evidence.Receipt,
	}}
	service, _ = NewQuotaCommitService(repository)
	result, err = service.Commit(context.Background(), command)
	if err != nil || result.Kind != QuotaCommitReplayed || repository.finalizeCalls != 0 {
		t.Fatalf("replayed result = %#v, calls = %d, error = %v", result, repository.finalizeCalls, err)
	}
}

func TestQuotaCommitServicePropagatesCancellation(t *testing.T) {
	t.Parallel()
	command, _ := quotaCommitFixture(t)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	service, _ := NewQuotaCommitService(&quotaCommitRepository{inspectContext: true})
	if _, err := service.Commit(cancelled, command); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}

type quotaCommitRepository struct {
	evidence       QuotaCommitEvidence
	inspectErr     error
	inspectContext bool
	finalized      quota.FinalizationResult
	finalizeErr    error
	finalization   quota.FinalizationCommand
	finalizeCalls  int
}

func (repository *quotaCommitRepository) InspectQuotaCommit(
	ctx context.Context,
	_ QuotaCommitCommand,
) (QuotaCommitEvidence, error) {
	if repository.inspectContext {
		return QuotaCommitEvidence{}, ctx.Err()
	}
	return repository.evidence, repository.inspectErr
}

func (repository *quotaCommitRepository) FinalizeQuotaCommit(
	_ context.Context,
	_ quota.Scope,
	command quota.FinalizationCommand,
) (quota.FinalizationResult, error) {
	repository.finalizeCalls++
	repository.finalization = command
	return repository.finalized, repository.finalizeErr
}

func quotaCommitFixture(t *testing.T) (QuotaCommitCommand, QuotaCommitEvidence) {
	t.Helper()
	query := quotaAuditQuery(t)
	reservationID, _ := quota.ParseReservationID("01991f20-61d2-7000-8000-000000000401")
	cardID, _ := quota.ParseCardID("01991f20-61d2-7000-8000-000000000501")
	fingerprint := quotaCommitFingerprint(t, "matching")
	reservation := quota.Reservation{
		Scope:         quota.Scope{AccountID: query.AccountID, VaultID: query.VaultID},
		ReservationID: reservationID, Fingerprint: fingerprint, CardID: cardID,
		ChangeKind: quota.ChangeCreate, CardDelta: 1, PlaintextByteDelta: 10,
		ChargedCardDelta: 1, ChargedPlaintextByteDelta: 10,
		UsageRevisionAtReservation: 1, State: quota.ReservationState{Kind: quota.ReservationReserved},
		CreatedAt: 2_000, ReconcileAfter: 4_000,
	}
	mutationID, _ := syncv2.ParseMutationID(string(reservationID))
	receiptFingerprint, _ := syncv2.ParseFingerprint(string(fingerprint))
	receiptCardID, _ := syncv2.ParseCardID(string(cardID))
	revision, _ := syncv2.ParseRevision(1)
	receipt := syncv2.Receipt{
		MutationID: mutationID, Fingerprint: receiptFingerprint, CardID: receiptCardID,
		AppliedRevision: revision, CommittedAt: reservation.CreatedAt,
	}
	return QuotaCommitCommand{
		AccountID: query.AccountID, VaultID: query.VaultID,
		ReservationID: reservationID, FinalizedAt: 5_000,
	}, QuotaCommitEvidence{Owned: true, Reservation: &reservation, Receipt: &receipt}
}

func quotaCommitFingerprint(t *testing.T, value string) quota.Fingerprint {
	t.Helper()
	digest := sha256.Sum256([]byte(value))
	fingerprint, err := quota.ParseFingerprint(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func withQuotaCommitCommand(command QuotaCommitCommand, update func(*QuotaCommitCommand)) QuotaCommitCommand {
	update(&command)
	return command
}
