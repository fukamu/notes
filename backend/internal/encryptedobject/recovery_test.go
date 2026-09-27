package encryptedobject_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestRecoverySharedFixtureDecodesAndProducesCompatibleReceipt(t *testing.T) {
	fixtureBytes, err := os.ReadFile("../../../contracts/fixtures/crypto/vault-recovery.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Manifest  json.RawMessage `json:"manifest"`
		DrilledAt int64           `json:"drilledAt"`
		Expected  struct {
			BackupID         string  `json:"backupId"`
			OperationID      string  `json:"operationId"`
			SourceVersion    int64   `json:"sourceVersion"`
			TargetVersion    int64   `json:"targetVersion"`
			ObjectCount      int64   `json:"objectCount"`
			VerifiedVersions []int64 `json:"verifiedVersions"`
		} `json:"expected"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	manifest, err := encryptedobject.DecodeRecoveryManifest(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	if plan := encryptedobject.PlanRecoveryDrill(manifest.RecoveryScope, manifest, fixture.DrilledAt); plan.Kind != encryptedobject.RecoveryDrillAccepted {
		t.Fatalf("PlanRecoveryDrill() = %#v", plan)
	}
	versions := make([]cryptocontent.DEKVersion, 0, len(manifest.Objects))
	for _, metadata := range manifest.Objects {
		versions = append(versions, metadata.DEKVersion)
	}
	completion := encryptedobject.CompleteRecoveryDrill(manifest, fixture.DrilledAt, int64(len(manifest.Objects)), versions)
	if completion.Kind != encryptedobject.RecoveryDrillVerified || completion.Receipt == nil {
		t.Fatalf("CompleteRecoveryDrill() = %#v", completion)
	}
	receipt := completion.Receipt
	if string(receipt.BackupID) != fixture.Expected.BackupID || string(receipt.OperationID) != fixture.Expected.OperationID ||
		int64(receipt.SourceVersion) != fixture.Expected.SourceVersion || int64(receipt.TargetVersion) != fixture.Expected.TargetVersion ||
		receipt.ObjectCount != fixture.Expected.ObjectCount || len(receipt.VerifiedVersions) != len(fixture.Expected.VerifiedVersions) {
		t.Fatalf("receipt = %#v, expected = %#v", receipt, fixture.Expected)
	}
	for index, version := range receipt.VerifiedVersions {
		if int64(version) != fixture.Expected.VerifiedVersions[index] {
			t.Fatalf("verified versions = %#v", receipt.VerifiedVersions)
		}
	}
	encodedReceipt, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	for _, secretField := range []string{"objectKey", "wrappedDek", "plaintext", "ciphertext"} {
		if strings.Contains(string(encodedReceipt), secretField) {
			t.Fatalf("receipt contains %q: %s", secretField, encodedReceipt)
		}
	}
	encodedManifest, err := encryptedobject.EncodeRecoveryManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := encryptedobject.DecodeRecoveryManifest(encodedManifest); err != nil {
		t.Fatalf("encoded manifest did not round-trip: %v", err)
	}
}

func TestRecoveryManifestFailsClosedAtTheBoundary(t *testing.T) {
	manifest := recoveryManifestFixture(t)
	encoded, err := encryptedobject.EncodeRecoveryManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var unknown map[string]any
	if err := json.Unmarshal(encoded, &unknown); err != nil {
		t.Fatal(err)
	}
	unknown["unexpected"] = true
	unknownBytes, _ := json.Marshal(unknown)
	if _, err := encryptedobject.DecodeRecoveryManifest(unknownBytes); err == nil {
		t.Fatal("unknown manifest field was accepted")
	}

	duplicate := recoveryManifestFixture(t)
	duplicate.Objects = append(duplicate.Objects, duplicate.Objects[0])
	if encryptedobject.ValidateRecoveryManifest(duplicate) == nil {
		t.Fatal("duplicate object identity/key was accepted")
	}

	missingVersion := recoveryManifestFixture(t)
	missingVersion.Objects[0].DEKVersion = 3
	if encryptedobject.ValidateRecoveryManifest(missingVersion) == nil {
		t.Fatal("object with missing DEK version was accepted")
	}

	overlong := recoveryManifestFixture(t)
	overlong.DeleteAfter = overlong.CapturedAt + encryptedobject.MaximumBackupRetentionMilli + 1
	if encryptedobject.ValidateRecoveryManifest(overlong) == nil {
		t.Fatal("overlong backup retention was accepted")
	}
}

func TestRecoveryPlanBlocksBeforeObjectAccessConditions(t *testing.T) {
	manifest := recoveryManifestFixture(t)
	foreign := manifest.RecoveryScope
	foreign.AccountID = mustRecoveryAccountID(t, "01991f20-61d2-7000-8000-000000001102")
	if plan := encryptedobject.PlanRecoveryDrill(foreign, manifest, 3_000); plan.Reason != encryptedobject.RecoveryScopeMismatch {
		t.Fatalf("foreign plan = %#v", plan)
	}
	if plan := encryptedobject.PlanRecoveryDrill(manifest.RecoveryScope, manifest, manifest.CapturedAt-1); plan.Reason != encryptedobject.RecoveryInvalidTimestamp {
		t.Fatalf("time plan = %#v", plan)
	}
	if plan := encryptedobject.PlanRecoveryDrill(manifest.RecoveryScope, manifest, manifest.DeleteAfter+1); plan.Reason != encryptedobject.RecoveryRetentionExpired {
		t.Fatalf("retention plan = %#v", plan)
	}
	pending := recoveryManifestFixture(t)
	pending.Reencryption = encryptedobject.RecoveryReencryptionPending{TargetVersion: 2}
	if plan := encryptedobject.PlanRecoveryDrill(pending.RecoveryScope, pending, 3_000); plan.Reason != encryptedobject.RecoveryCheckpointIncomplete {
		t.Fatalf("checkpoint plan = %#v", plan)
	}
}

func TestKeyRetirementNeverAuthorizesDestruction(t *testing.T) {
	manifest := recoveryManifestFixture(t)
	completion := encryptedobject.CompleteRecoveryDrill(manifest, 3_000, 2, []cryptocontent.DEKVersion{2, 1})
	if completion.Receipt == nil {
		t.Fatal("missing receipt")
	}
	input := cleanRetirementInput(manifest, completion.Receipt)
	result := encryptedobject.EvaluateKeyRetirement(input)
	if result.Kind != encryptedobject.KeyRetirementApprovalRequired || result.Approval != encryptedobject.ExplicitKeyDestructionApproval ||
		result.SourceVersion != 1 || result.TargetVersion != 2 || len(result.Reasons) != 0 {
		t.Fatalf("EvaluateKeyRetirement() = %#v", result)
	}
}

func TestKeyRetirementReportsEveryUnsafeEvidenceClass(t *testing.T) {
	manifest := recoveryManifestFixture(t)
	completion := encryptedobject.CompleteRecoveryDrill(manifest, 3_000, 2, []cryptocontent.DEKVersion{1, 2})
	if completion.Receipt == nil {
		t.Fatal("missing receipt")
	}
	base := cleanRetirementInput(manifest, completion.Receipt)

	tests := []struct {
		name   string
		mutate func(*encryptedobject.KeyRetirementInput)
		reason encryptedobject.KeyRetirementBlockReason
	}{
		{"old object", func(input *encryptedobject.KeyRetirementInput) { input.ActiveInventory.OlderObjects = 1 }, encryptedobject.RetirementActiveOldVersion},
		{"old write", func(input *encryptedobject.KeyRetirementInput) { input.ActiveInventory.OlderWriteIntents = 1 }, encryptedobject.RetirementPendingOldWrite},
		{"newer object", func(input *encryptedobject.KeyRetirementInput) { input.ActiveInventory.NewerObjects = 1 }, encryptedobject.RetirementUnexpectedNewerVersion},
		{"missing owner", func(input *encryptedobject.KeyRetirementInput) { input.ActiveInventory.OwnerPresent = false }, encryptedobject.RetirementIncompleteActive},
		{"incomplete backups", func(input *encryptedobject.KeyRetirementInput) { input.BackupInventoryComplete = false }, encryptedobject.RetirementIncompleteBackups},
		{"retained backup", func(input *encryptedobject.KeyRetirementInput) {
			input.Backups[0].State = encryptedobject.BackupRetained{}
			input.Backups[0].DeleteAfter = 5_000
		}, encryptedobject.RetirementRetainedBackup},
		{"overdue backup", func(input *encryptedobject.KeyRetirementInput) {
			input.Backups[0].State = encryptedobject.BackupRetained{}
		}, encryptedobject.RetirementBackupOverdue},
		{"missing drill", func(input *encryptedobject.KeyRetirementInput) { input.DrillReceipt = nil }, encryptedobject.RetirementMissingDrill},
		{"wrong drill", func(input *encryptedobject.KeyRetirementInput) {
			copyOfReceipt := *input.DrillReceipt
			copyOfReceipt.SourceVersion = 2
			input.DrillReceipt = &copyOfReceipt
		}, encryptedobject.RetirementInvalidDrill},
		{"invalid rotation", func(input *encryptedobject.KeyRetirementInput) {
			input.Rotation.Revision = 2
		}, encryptedobject.RetirementRotationIncomplete},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := cloneRetirementInput(base)
			test.mutate(&input)
			result := encryptedobject.EvaluateKeyRetirement(input)
			if result.Kind != encryptedobject.KeyRetirementBlocked || !containsRetirementReason(result.Reasons, test.reason) {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func recoveryManifestFixture(t *testing.T) encryptedobject.RecoveryManifest {
	t.Helper()
	accountID := mustRecoveryAccountID(t, "01991f20-61d2-7000-8000-000000001101")
	vaultID := mustRecoveryVaultID(t, "01991f20-61d2-7000-8000-000000001201")
	backupID, _ := encryptedobject.ParseRecoveryBackupID("backup_fixture_a")
	operationID, _ := cryptocontent.ParseRotationOperationID("01991f20-61d2-7000-8000-000000001901")
	keyOne := recoveryDEKMetadata(vaultID, 1, 500)
	keyTwo := recoveryDEKMetadata(vaultID, 2, 2_000)
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, 2, []cryptocontent.VaultDEKMetadata{keyOne, keyTwo})
	if err != nil {
		t.Fatal(err)
	}
	rotation := cryptocontent.RotationOperation{
		RotationScope: cryptocontent.RotationScope{AccountID: accountID, VaultID: vaultID},
		OperationID:   operationID, Revision: 3, SourceVersion: 1, TargetVersion: 2,
		State:          cryptocontent.RotationCompleted{Metadata: keyTwo, CompletedAtMilli: 2_100},
		CreatedAtMilli: 1_500, UpdatedAtMilli: 2_100,
	}
	objects := []encryptedobject.Metadata{
		recoveryMetadata(t, "01991f20-61d2-7000-8000-000000000101", "01991f20-61d2-7000-8000-000000000201", 'A', 1, 1),
		recoveryMetadata(t, "01991f20-61d2-7000-8000-000000000102", "01991f20-61d2-7000-8000-000000000202", 'B', 2, 2),
	}
	return encryptedobject.RecoveryManifest{
		Format:        encryptedobject.VaultRecoveryFormat,
		RecoveryScope: encryptedobject.RecoveryScope{AccountID: accountID, VaultID: vaultID},
		BackupID:      backupID, CapturedAt: 2_200, DeleteAfter: 2_200 + encryptedobject.MaximumBackupRetentionMilli,
		Keyring: keyring, Rotation: rotation,
		Reencryption: encryptedobject.RecoveryReencryptionCompleted{TargetVersion: 2}, Objects: objects,
	}
}

func recoveryDEKMetadata(vaultID identity.VaultID, version cryptocontent.DEKVersion, createdAt int64) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: version,
		KEKReference: "fake-kek-version-" + string(rune('0'+version)),
		WrappedDEK:   "ZmFrZS13cmFwcGVkLWRlaw", CreatedAtMilli: createdAt,
	}
}

func recoveryMetadata(
	t *testing.T,
	objectID string,
	writeIDValue string,
	keyCharacter byte,
	revision int64,
	version int64,
) encryptedobject.Metadata {
	t.Helper()
	writeID, _ := encryptedobject.ParseWriteID(writeIDValue)
	objectKey, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat(string(keyCharacter), 43))
	parsedRevision, _ := cryptocontent.ParseObjectRevision(revision)
	parsedVersion, _ := cryptocontent.ParseDEKVersion(version)
	return encryptedobject.Metadata{
		Object:         encryptedobject.ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: objectID},
		ObjectRevision: parsedRevision, WriteID: writeID, ObjectKey: objectKey,
		PlaintextBytes: 16, CiphertextBytes: 128, CryptoVersion: cryptocontent.EnvelopeCryptoVersion,
		DEKVersion: parsedVersion, CreatedAtMilli: 1_000 + revision,
	}
}

func cleanRetirementInput(
	manifest encryptedobject.RecoveryManifest,
	receipt *encryptedobject.RecoveryDrillReceipt,
) encryptedobject.KeyRetirementInput {
	return encryptedobject.KeyRetirementInput{
		Scope: manifest.RecoveryScope, Rotation: manifest.Rotation,
		ActiveInventory:         encryptedobject.ReencryptionInventory{OwnerPresent: true, TargetObjects: 2},
		BackupInventoryComplete: true,
		Backups: []encryptedobject.BackupRetentionReference{{
			RecoveryScope: manifest.RecoveryScope, BackupID: manifest.BackupID,
			CapturedAt: manifest.CapturedAt, DeleteAfter: 3_000,
			DEKVersions: []cryptocontent.DEKVersion{1, 2},
			State:       encryptedobject.BackupDeletionConfirmed{DeletedAt: 3_000},
		}},
		DrillReceipt: receipt, EvaluatedAt: 4_000,
	}
}

func cloneRetirementInput(input encryptedobject.KeyRetirementInput) encryptedobject.KeyRetirementInput {
	result := input
	result.Backups = append([]encryptedobject.BackupRetentionReference(nil), input.Backups...)
	for index := range result.Backups {
		result.Backups[index].DEKVersions = append([]cryptocontent.DEKVersion(nil), result.Backups[index].DEKVersions...)
	}
	if input.DrillReceipt != nil {
		receipt := *input.DrillReceipt
		receipt.VerifiedVersions = append([]cryptocontent.DEKVersion(nil), input.DrillReceipt.VerifiedVersions...)
		result.DrillReceipt = &receipt
	}
	return result
}

func containsRetirementReason(values []encryptedobject.KeyRetirementBlockReason, expected encryptedobject.KeyRetirementBlockReason) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func mustRecoveryAccountID(t *testing.T, value string) identity.AccountID {
	t.Helper()
	parsed, err := identity.ParseAccountID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustRecoveryVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
