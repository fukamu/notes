package postgres

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestValidDeletionPhaseAcceptsCrashWindowsAndRejectsDataBehindReceipts(t *testing.T) {
	first := deletionSnapshotAtStep(t, 0)
	if !validDeletionPhase(first, deletionPhaseFacts{
		accountCount: 1, vaultCount: 1, activeSessions: 1, wrappedKeys: 1, allLiveRows: 6,
	}) {
		t.Fatal("prereceipt revoke phase was rejected")
	}
	revokedAhead := deletionPhaseFacts{
		accountCount: 1, vaultCount: 1, activeSessions: 0, wrappedKeys: 1, allLiveRows: 5,
	}
	if !validDeletionPhase(first, revokedAhead) {
		t.Fatal("session-effect-before-receipt crash was rejected")
	}
	second := deletionSnapshotAtStep(t, 1)
	behindSession := revokedAhead
	behindSession.activeSessions = 1
	if validDeletionPhase(second, behindSession) {
		t.Fatal("active session behind revocation receipt was accepted")
	}
	private := deletionSnapshotAtStep(t, 3)
	privateFacts := deletionPhaseFacts{
		accountCount: 1, vaultCount: 1, wrappedKeys: 1, allLiveRows: 4,
	}
	if !validDeletionPhase(private, privateFacts) {
		t.Fatal("data-purge-before-receipt or empty outbox phase was rejected")
	}
	privateFacts.vaultDataRows = 1
	if validDeletionPhase(private, privateFacts) {
		t.Fatal("Vault data behind purge receipt was accepted")
	}
	final := deletionSnapshotAtStep(t, 4)
	finalFacts := deletionPhaseFacts{
		accountCount: 1, vaultCount: 1, wrappedKeys: 0, allLiveRows: 3,
	}
	if !validDeletionPhase(final, finalFacts) {
		t.Fatal("wrapped-key-effect-before-final receipt crash was rejected")
	}
	finalFacts.outboxRows = 1
	if validDeletionPhase(final, finalFacts) {
		t.Fatal("outbox behind private-object receipt was accepted")
	}
	ownerAbsent := deletionPhaseFacts{}
	if !validDeletionPhase(final, ownerAbsent) {
		t.Fatal("live-delete-before-final receipt crash was rejected")
	}
	ownerAbsent.accountCount = 1
	if validDeletionPhase(final, ownerAbsent) {
		t.Fatal("partial owner removal was accepted")
	}
}

func TestValidDeletionPhaseRequiresEmptyLiveInventoryAfterCompletion(t *testing.T) {
	completed := deletionCompletedSnapshot(t)
	if !validDeletionPhase(completed, deletionPhaseFacts{}) {
		t.Fatal("empty completed phase was rejected")
	}
	for name, mutate := range map[string]func(*deletionPhaseFacts){
		"owner":  func(facts *deletionPhaseFacts) { facts.accountCount, facts.vaultCount, facts.allLiveRows = 1, 1, 2 },
		"key":    func(facts *deletionPhaseFacts) { facts.wrappedKeys, facts.allLiveRows = 1, 1 },
		"data":   func(facts *deletionPhaseFacts) { facts.vaultDataRows, facts.allLiveRows = 1, 1 },
		"outbox": func(facts *deletionPhaseFacts) { facts.outboxRows, facts.allLiveRows = 1, 1 },
	} {
		t.Run(name, func(t *testing.T) {
			facts := deletionPhaseFacts{}
			mutate(&facts)
			if validDeletionPhase(completed, facts) {
				t.Fatalf("completed phase accepted %s live inventory", name)
			}
		})
	}
}

func deletionSnapshotAtStep(t *testing.T, target int) accountdeletion.Snapshot {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	operationID, _ := accountdeletion.ParseOperationID("01999c20-9e33-7000-8000-000000000003")
	started := accountdeletion.PlanStart(
		accountdeletion.Scope{AccountID: accountID, VaultID: vaultID}, operationID, 1_000,
	)
	snapshot := accountdeletion.Snapshot{Operation: started.Operation}
	for range target {
		claimed := accountdeletion.PlanStepClaim(
			snapshot.Operation, snapshot.Operation.UpdatedAt+10, snapshot.Operation.UpdatedAt+20,
		)
		running := claimed.Transition.Next.State.(accountdeletion.Running)
		completed := accountdeletion.PlanStepCompletion(claimed.Transition.Next, accountdeletion.StepResult{
			Kind: accountdeletion.StepSucceeded, Step: running.Step, Attempt: running.Attempt,
			FinishedAt: claimed.Transition.Next.UpdatedAt + 5,
		}, nil, accountdeletion.RetryPolicy{})
		snapshot.Operation = completed.Transition.Next
		snapshot.Receipts = append(snapshot.Receipts, *completed.Transition.Receipt)
	}
	if !accountdeletion.ValidSnapshot(snapshot) {
		t.Fatalf("invalid fixture snapshot = %#v", snapshot)
	}
	return snapshot
}

func deletionCompletedSnapshot(t *testing.T) accountdeletion.Snapshot {
	t.Helper()
	return deletionSnapshotAtStep(t, 5)
}
