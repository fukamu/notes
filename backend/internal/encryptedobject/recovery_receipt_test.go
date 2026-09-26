package encryptedobject_test

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestRecoveryDrillReceiptValidationRejectsMalformedEvidence(t *testing.T) {
	manifest := recoveryManifestFixture(t)
	completion := encryptedobject.CompleteRecoveryDrill(
		manifest, 3_000, int64(len(manifest.Objects)), []cryptocontent.DEKVersion{1, 2},
	)
	if completion.Receipt == nil || encryptedobject.ValidateRecoveryDrillReceipt(*completion.Receipt) != nil {
		t.Fatalf("valid completion=%#v", completion)
	}
	tests := []func(*encryptedobject.RecoveryDrillReceipt){
		func(receipt *encryptedobject.RecoveryDrillReceipt) { receipt.BackupID = "bad id" },
		func(receipt *encryptedobject.RecoveryDrillReceipt) { receipt.DrilledAt = receipt.DeleteAfter + 1 },
		func(receipt *encryptedobject.RecoveryDrillReceipt) { receipt.TargetVersion = receipt.SourceVersion },
		func(receipt *encryptedobject.RecoveryDrillReceipt) {
			receipt.VerifiedVersions = []cryptocontent.DEKVersion{2, 1}
		},
		func(receipt *encryptedobject.RecoveryDrillReceipt) {
			receipt.ObjectCount = 1
			receipt.VerifiedVersions = []cryptocontent.DEKVersion{1, 2}
		},
	}
	for index, mutate := range tests {
		receipt := *completion.Receipt
		receipt.VerifiedVersions = append([]cryptocontent.DEKVersion(nil), completion.Receipt.VerifiedVersions...)
		mutate(&receipt)
		if encryptedobject.ValidateRecoveryDrillReceipt(receipt) == nil {
			t.Fatalf("case %d accepted %#v", index, receipt)
		}
	}
}
