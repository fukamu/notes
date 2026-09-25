package syncv2

import (
	"reflect"
	"testing"
)

const (
	cardA        CardID      = "01890f11-1111-7111-8111-111111111111"
	cardB        CardID      = "01890f11-2222-7222-8222-222222222222"
	conflictA    ConflictID  = "01890f11-3333-7333-8333-333333333333"
	conflictB    ConflictID  = "01890f11-4444-7444-8444-444444444444"
	mutationA    MutationID  = "01890f11-5555-7555-8555-555555555555"
	mutationB    MutationID  = "01890f11-6666-7666-8666-666666666666"
	fingerprintA Fingerprint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA"
	fingerprintB Fingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbA"
)

func revision(value int64) Revision { return Revision(value) }

func emptySnapshot() Snapshot {
	return Snapshot{State: State{NextDisplayID: 1, NextSequence: 1}}
}

func existingCardSnapshot() Snapshot {
	return Snapshot{
		State: State{NextDisplayID: 2, NextSequence: 2},
		Card:  &CardHead{CardID: cardA, OfficialDisplayID: 1, Revision: 1, UpdatedAt: 1_000},
	}
}

func createCommand() CommitCommand {
	return CommitCommand{
		Kind: CommandCardUpsert, MutationID: mutationA, Fingerprint: fingerprintA,
		CommittedAt: 1_100, CardID: cardA, NextRevision: 1, OccurredAt: 1_000,
	}
}

func TestIdentifierBoundaries(t *testing.T) {
	if _, err := ParseFingerprint(string(fingerprintA)); err != nil {
		t.Fatalf("parse canonical fingerprint: %v", err)
	}
	for _, invalid := range []string{"short", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB"} {
		if _, err := ParseFingerprint(invalid); err == nil {
			t.Fatalf("accepted invalid fingerprint %q", invalid)
		}
	}
}

func TestPlanCommitAllocatesWithoutMutatingSnapshot(t *testing.T) {
	snapshot := emptySnapshot()
	before := snapshot
	plan := PlanCommitCommand(createCommand(), snapshot)
	if plan.Kind != PlanCommit || plan.Receipt.AppliedRevision != 1 ||
		plan.OfficialDisplayID != 1 || plan.NextState != (State{NextDisplayID: 2, NextSequence: 2}) {
		t.Fatalf("unexpected create plan: %#v", plan)
	}
	if len(plan.Changes) != 1 || plan.Changes[0].Sequence != 1 ||
		plan.Changes[0].Kind != ChangeCardUpsert || plan.Changes[0].OfficialDisplayID != 1 {
		t.Fatalf("unexpected create changes: %#v", plan.Changes)
	}
	if !reflect.DeepEqual(snapshot, before) {
		t.Fatalf("planner mutated snapshot: before=%#v after=%#v", before, snapshot)
	}
}

func TestPlanCommitReplayAndFingerprintReuse(t *testing.T) {
	receipt := &Receipt{
		MutationID: mutationA, Fingerprint: fingerprintA, CardID: cardA,
		AppliedRevision: 1, CommittedAt: 1_100,
	}
	snapshot := emptySnapshot()
	snapshot.ExistingReceipt = receipt
	if plan := PlanCommitCommand(createCommand(), snapshot); plan.Kind != PlanReplay || plan.Receipt != *receipt {
		t.Fatalf("expected replay, got %#v", plan)
	}
	command := createCommand()
	command.Fingerprint = fingerprintB
	if plan := PlanCommitCommand(command, snapshot); plan.Kind != PlanRejected || plan.Reason != ReasonIdempotencyKeyReuse {
		t.Fatalf("expected key reuse rejection, got %#v", plan)
	}
}

func TestPlanCommitRevisionAndTimelineRules(t *testing.T) {
	expected := revision(1)
	command := CommitCommand{
		Kind: CommandCardUpsert, MutationID: mutationB, Fingerprint: fingerprintB,
		CommittedAt: 1_100, CardID: cardA, ExpectedRevision: &expected,
		NextRevision: 2, OccurredAt: 1_001,
	}
	if plan := PlanCommitCommand(command, existingCardSnapshot()); plan.Kind != PlanCommit || plan.NextState.NextSequence != 3 {
		t.Fatalf("expected update plan, got %#v", plan)
	}
	command.NextRevision = 3
	if plan := PlanCommitCommand(command, existingCardSnapshot()); plan.Reason != ReasonInvalidNextRevision {
		t.Fatalf("expected revision rejection, got %#v", plan)
	}
	command.NextRevision = 2
	command.OccurredAt = 999
	if plan := PlanCommitCommand(command, existingCardSnapshot()); plan.Reason != ReasonInvalidTimeline {
		t.Fatalf("expected timeline rejection, got %#v", plan)
	}
	command.OccurredAt = 1_001
	command.CommittedAt = -1
	if plan := PlanCommitCommand(command, existingCardSnapshot()); plan.Reason != ReasonInvalidTimeline {
		t.Fatalf("expected committed-at rejection, got %#v", plan)
	}
}

func TestPlanResolveAndDeleteOrderTombstones(t *testing.T) {
	expected := revision(1)
	snapshot := existingCardSnapshot()
	snapshot.SelectedConflicts = []ConflictHead{
		{ConflictID: conflictA, CardID: cardA, ServerRevision: 1, CreatedAt: 1_010},
		{ConflictID: conflictB, CardID: cardA, ServerRevision: 1, CreatedAt: 1_011},
	}
	resolve := CommitCommand{
		Kind: CommandResolveConflicts, MutationID: mutationB, Fingerprint: fingerprintB,
		CommittedAt: 1_100, CardID: cardA, ExpectedRevision: &expected, NextRevision: 2,
		OccurredAt: 1_100, ConflictIDs: []ConflictID{conflictA, conflictB},
	}
	plan := PlanCommitCommand(resolve, snapshot)
	if plan.Kind != PlanCommit || len(plan.Changes) != 3 ||
		plan.Changes[0].Kind != ChangeCardUpsert || plan.Changes[1].Kind != ChangeConflictTombstone ||
		plan.Changes[2].Kind != ChangeConflictTombstone {
		t.Fatalf("unexpected resolve plan: %#v", plan)
	}

	deleteSnapshot := existingCardSnapshot()
	deleteSnapshot.AllCardConflicts = []ConflictHead{
		{ConflictID: conflictB, CardID: cardA, ServerRevision: 1, CreatedAt: 1_010},
		{ConflictID: conflictA, CardID: cardA, ServerRevision: 1, CreatedAt: 1_011},
	}
	deleteCommand := CommitCommand{
		Kind: CommandCardDelete, MutationID: mutationB, Fingerprint: fingerprintB,
		CommittedAt: 1_100, CardID: cardA, ExpectedRevision: &expected, NextRevision: 2, OccurredAt: 1_100,
	}
	deletePlan := PlanCommitCommand(deleteCommand, deleteSnapshot)
	if deletePlan.Kind != PlanCommit || len(deletePlan.Changes) != 3 ||
		deletePlan.Changes[0].ConflictID != conflictA || deletePlan.Changes[1].ConflictID != conflictB ||
		deletePlan.Changes[2].Kind != ChangeCardTombstone {
		t.Fatalf("unexpected delete plan: %#v", deletePlan)
	}
	if !reflect.DeepEqual(deleteSnapshot.AllCardConflicts[0].ConflictID, conflictB) {
		t.Fatal("delete planning mutated caller-owned conflict order")
	}
}

func TestPlanResolveRejectsMissingDuplicateAndCrossCardConflicts(t *testing.T) {
	expected := revision(1)
	command := CommitCommand{
		Kind: CommandResolveConflicts, MutationID: mutationB, Fingerprint: fingerprintB,
		CommittedAt: 1_100, CardID: cardA, ExpectedRevision: &expected,
		NextRevision: 2, OccurredAt: 1_100, ConflictIDs: []ConflictID{conflictA},
	}
	if plan := PlanCommitCommand(command, existingCardSnapshot()); plan.Reason != ReasonMissingConflict {
		t.Fatalf("expected missing conflict, got %#v", plan)
	}
	snapshot := existingCardSnapshot()
	snapshot.SelectedConflicts = []ConflictHead{{ConflictID: conflictA, CardID: cardB, ServerRevision: 1}}
	if plan := PlanCommitCommand(command, snapshot); plan.Reason != ReasonConflictCardMismatch {
		t.Fatalf("expected card mismatch, got %#v", plan)
	}
	command.ConflictIDs = []ConflictID{conflictA, conflictA}
	snapshot.SelectedConflicts = []ConflictHead{{ConflictID: conflictA, CardID: cardA, ServerRevision: 1}}
	if plan := PlanCommitCommand(command, snapshot); plan.Reason != ReasonMissingConflict {
		t.Fatalf("expected duplicate rejection, got %#v", plan)
	}
}

func TestPlanPageKeepsWatermarkAndRejectsGaps(t *testing.T) {
	change := func(sequence Sequence) Change {
		return Change{
			Kind: ChangeCardUpsert, Sequence: sequence, CardID: cardA,
			Revision: 1, OfficialDisplayID: 1, OccurredAt: 1_000,
		}
	}
	page, ok := PlanPage(0, 3, []Change{change(1), change(2), change(3)}, 2)
	if !ok || page.Kind != PageMore || page.HighWatermark != 3 || page.AfterSequence != 2 || len(page.Changes) != 2 {
		t.Fatalf("unexpected bounded page: %#v, valid=%v", page, ok)
	}
	if _, ok := PlanPage(0, 3, []Change{change(1), change(3)}, 3); ok {
		t.Fatal("accepted page with sequence gap")
	}
	if _, ok := PlanPage(1, 3, nil, 3); ok {
		t.Fatal("accepted incomplete empty page")
	}
}

func TestPlanCommitRejectsUnsafeAllocatorState(t *testing.T) {
	for _, state := range []State{
		{NextDisplayID: MaximumDisplayID + 1, NextSequence: 1},
		{NextDisplayID: 1, NextSequence: Sequence(MaximumSafeInteger)},
	} {
		plan := PlanCommitCommand(createCommand(), Snapshot{State: state})
		if plan.Kind != PlanRejected || plan.Reason != ReasonInvalidState {
			t.Fatalf("expected unsafe state rejection, got %#v", plan)
		}
	}
}

func TestValidateCommitCommandBoundsConflictIDsBeforeStorage(t *testing.T) {
	expected := revision(1)
	command := CommitCommand{
		Kind: CommandResolveConflicts, MutationID: mutationB, Fingerprint: fingerprintB,
		CommittedAt: 1_100, CardID: cardA, ExpectedRevision: &expected,
		NextRevision: 2, OccurredAt: 1_100,
		ConflictIDs: make([]ConflictID, MaximumConflictIDs+1),
	}
	for index := range command.ConflictIDs {
		command.ConflictIDs[index] = conflictA
	}
	if reason := ValidateCommitCommand(command); reason != ReasonInvalidState {
		t.Fatalf("oversized conflict list reason = %q", reason)
	}
}
