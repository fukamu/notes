package encryptedobject

import (
	"errors"
	"regexp"
	"sort"
	"strconv"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	VaultRecoveryFormat         = "fukamu-vault-recovery/v1"
	MaximumBackupRetentionMilli = int64(30 * 24 * 60 * 60 * 1_000)
	MaximumRecoveryObjects      = 30_000
)

var (
	ErrInvalidRecovery = errors.New("invalid Vault recovery value")
	backupIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

type RecoveryBackupID string

type RecoveryScope struct {
	AccountID identity.AccountID `json:"accountId"`
	VaultID   identity.VaultID   `json:"vaultId"`
}

type RecoveryReencryptionState interface {
	isRecoveryReencryptionState()
}

type RecoveryReencryptionCompleted struct {
	TargetVersion cryptocontent.DEKVersion
}

type RecoveryReencryptionPending struct {
	TargetVersion cryptocontent.DEKVersion
	After         *ReencryptionPosition
}

func (RecoveryReencryptionCompleted) isRecoveryReencryptionState() {}
func (RecoveryReencryptionPending) isRecoveryReencryptionState()   {}

type RecoveryManifest struct {
	Format VaultRecoveryFormatValue
	RecoveryScope
	BackupID     RecoveryBackupID
	CapturedAt   int64
	DeleteAfter  int64
	Keyring      cryptocontent.VaultDEKKeyring
	Rotation     cryptocontent.RotationOperation
	Reencryption RecoveryReencryptionState
	Objects      []Metadata
}

type VaultRecoveryFormatValue string

type RecoveryDrillReceipt struct {
	RecoveryScope
	BackupID         RecoveryBackupID                  `json:"backupId"`
	OperationID      cryptocontent.RotationOperationID `json:"operationId"`
	SourceVersion    cryptocontent.DEKVersion          `json:"sourceVersion"`
	TargetVersion    cryptocontent.DEKVersion          `json:"targetVersion"`
	CapturedAt       int64                             `json:"capturedAt"`
	DeleteAfter      int64                             `json:"deleteAfter"`
	DrilledAt        int64                             `json:"drilledAt"`
	ObjectCount      int64                             `json:"objectCount"`
	VerifiedVersions []cryptocontent.DEKVersion        `json:"verifiedVersions"`
}

type RecoveryDrillPlanKind string

const (
	RecoveryDrillAccepted RecoveryDrillPlanKind = "accepted"
	RecoveryDrillBlocked  RecoveryDrillPlanKind = "blocked"
)

type RecoveryDrillBlockReason string

const (
	RecoveryScopeMismatch        RecoveryDrillBlockReason = "scope-mismatch"
	RecoveryInvalidTimestamp     RecoveryDrillBlockReason = "invalid-timestamp"
	RecoveryRetentionExpired     RecoveryDrillBlockReason = "retention-expired"
	RecoveryRotationIncomplete   RecoveryDrillBlockReason = "rotation-incomplete"
	RecoveryCheckpointIncomplete RecoveryDrillBlockReason = "incomplete-checkpoint"
)

type RecoveryDrillPlan struct {
	Kind   RecoveryDrillPlanKind
	Reason RecoveryDrillBlockReason
}

type RecoveryDrillCompletionKind string

const (
	RecoveryDrillVerified        RecoveryDrillCompletionKind = "verified"
	RecoveryDrillInvalidEvidence RecoveryDrillCompletionKind = "invalid-evidence"
)

type RecoveryDrillCompletion struct {
	Kind    RecoveryDrillCompletionKind
	Receipt *RecoveryDrillReceipt
}

type BackupRetentionState interface {
	isBackupRetentionState()
}

type BackupRetained struct{}

type BackupDeletionConfirmed struct {
	DeletedAt int64
}

func (BackupRetained) isBackupRetentionState()          {}
func (BackupDeletionConfirmed) isBackupRetentionState() {}

type BackupRetentionReference struct {
	RecoveryScope
	BackupID    RecoveryBackupID
	CapturedAt  int64
	DeleteAfter int64
	DEKVersions []cryptocontent.DEKVersion
	State       BackupRetentionState
}

type KeyRetirementBlockReason string

const (
	RetirementScopeMismatch          KeyRetirementBlockReason = "scope-mismatch"
	RetirementInvalidTimestamp       KeyRetirementBlockReason = "invalid-timestamp"
	RetirementRotationIncomplete     KeyRetirementBlockReason = "rotation-incomplete"
	RetirementIncompleteActive       KeyRetirementBlockReason = "incomplete-active-inventory"
	RetirementActiveOldVersion       KeyRetirementBlockReason = "active-old-version"
	RetirementPendingOldWrite        KeyRetirementBlockReason = "pending-old-write"
	RetirementUnexpectedNewerVersion KeyRetirementBlockReason = "unexpected-newer-version"
	RetirementIncompleteBackups      KeyRetirementBlockReason = "incomplete-backup-inventory"
	RetirementInvalidBackup          KeyRetirementBlockReason = "invalid-backup-evidence"
	RetirementRetainedBackup         KeyRetirementBlockReason = "retained-backup"
	RetirementBackupOverdue          KeyRetirementBlockReason = "backup-retention-overdue"
	RetirementMissingDrill           KeyRetirementBlockReason = "missing-recovery-drill"
	RetirementInvalidDrill           KeyRetirementBlockReason = "invalid-recovery-drill"
)

type KeyRetirementEvaluationKind string

const (
	KeyRetirementBlocked           KeyRetirementEvaluationKind = "blocked"
	KeyRetirementApprovalRequired  KeyRetirementEvaluationKind = "approval-required"
	ExplicitKeyDestructionApproval                             = "explicit-production-key-destruction-approval-required"
)

type KeyRetirementEvaluation struct {
	Kind    KeyRetirementEvaluationKind
	Reasons []KeyRetirementBlockReason
	RecoveryScope
	SourceVersion cryptocontent.DEKVersion
	TargetVersion cryptocontent.DEKVersion
	EvaluatedAt   int64
	Approval      string
}

type KeyRetirementInput struct {
	Scope                   RecoveryScope
	Rotation                cryptocontent.RotationOperation
	ActiveInventory         ReencryptionInventory
	BackupInventoryComplete bool
	Backups                 []BackupRetentionReference
	DrillReceipt            *RecoveryDrillReceipt
	EvaluatedAt             int64
}

func ParseRecoveryBackupID(value string) (RecoveryBackupID, error) {
	if !backupIDPattern.MatchString(value) {
		return "", ErrInvalidRecovery
	}
	return RecoveryBackupID(value), nil
}

func ValidateRecoveryScope(scope RecoveryScope) error {
	if _, err := identity.ParseAccountID(string(scope.AccountID)); err != nil {
		return ErrInvalidRecovery
	}
	if _, err := identity.ParseVaultID(string(scope.VaultID)); err != nil {
		return ErrInvalidRecovery
	}
	return nil
}

func ValidateRecoveryManifest(manifest RecoveryManifest) error {
	if manifest.Format != VaultRecoveryFormat || ValidateRecoveryScope(manifest.RecoveryScope) != nil ||
		!backupIDPattern.MatchString(string(manifest.BackupID)) || !validTimestamp(manifest.CapturedAt) ||
		!validTimestamp(manifest.DeleteAfter) || manifest.DeleteAfter < manifest.CapturedAt ||
		manifest.DeleteAfter-manifest.CapturedAt > MaximumBackupRetentionMilli ||
		cryptocontent.ValidateVaultDEKKeyring(manifest.Keyring) != nil ||
		cryptocontent.ValidateRotationOperation(manifest.Rotation) != nil ||
		manifest.Keyring.VaultID != manifest.VaultID || manifest.Rotation.AccountID != manifest.AccountID ||
		manifest.Rotation.VaultID != manifest.VaultID || manifest.CapturedAt < manifest.Rotation.UpdatedAtMilli ||
		!cryptocontent.ValidRotationSnapshot(cryptocontent.RotationSnapshot{
			Keyring: manifest.Keyring, Operation: &manifest.Rotation,
		}) || len(manifest.Objects) > MaximumRecoveryObjects {
		return ErrInvalidRecovery
	}
	targetVersion, completed := recoveryTargetVersion(manifest.Reencryption)
	if targetVersion != manifest.Rotation.TargetVersion {
		return ErrInvalidRecovery
	}
	if completed {
		if _, ok := manifest.Rotation.State.(cryptocontent.RotationCompleted); !ok {
			return ErrInvalidRecovery
		}
	}
	available := make(map[cryptocontent.DEKVersion]struct{}, len(manifest.Keyring.Versions))
	for _, metadata := range manifest.Keyring.Versions {
		available[metadata.DEKVersion] = struct{}{}
	}
	identities := make(map[string]struct{}, len(manifest.Objects))
	objectKeys := make(map[ObjectKey]struct{}, len(manifest.Objects))
	for _, metadata := range manifest.Objects {
		identityKey := string(metadata.Object.Kind) + ":" + metadata.Object.ObjectID + ":" + strconv.FormatInt(int64(metadata.ObjectRevision), 10)
		_, duplicateIdentity := identities[identityKey]
		_, duplicateObjectKey := objectKeys[metadata.ObjectKey]
		_, versionAvailable := available[metadata.DEKVersion]
		if ValidateMetadata(metadata) != nil || duplicateIdentity || duplicateObjectKey || !versionAvailable {
			return ErrInvalidRecovery
		}
		identities[identityKey] = struct{}{}
		objectKeys[metadata.ObjectKey] = struct{}{}
	}
	return nil
}

func PlanRecoveryDrill(scope RecoveryScope, manifest RecoveryManifest, drilledAt int64) RecoveryDrillPlan {
	if manifest.AccountID != scope.AccountID || manifest.VaultID != scope.VaultID {
		return RecoveryDrillPlan{Kind: RecoveryDrillBlocked, Reason: RecoveryScopeMismatch}
	}
	if !validTimestamp(drilledAt) || drilledAt < manifest.CapturedAt {
		return RecoveryDrillPlan{Kind: RecoveryDrillBlocked, Reason: RecoveryInvalidTimestamp}
	}
	if drilledAt > manifest.DeleteAfter {
		return RecoveryDrillPlan{Kind: RecoveryDrillBlocked, Reason: RecoveryRetentionExpired}
	}
	if _, completed := manifest.Rotation.State.(cryptocontent.RotationCompleted); !completed {
		return RecoveryDrillPlan{Kind: RecoveryDrillBlocked, Reason: RecoveryRotationIncomplete}
	}
	if _, completed := manifest.Reencryption.(RecoveryReencryptionCompleted); !completed {
		return RecoveryDrillPlan{Kind: RecoveryDrillBlocked, Reason: RecoveryCheckpointIncomplete}
	}
	return RecoveryDrillPlan{Kind: RecoveryDrillAccepted}
}

func CompleteRecoveryDrill(
	manifest RecoveryManifest,
	drilledAt int64,
	verifiedObjects int64,
	verifiedVersions []cryptocontent.DEKVersion,
) RecoveryDrillCompletion {
	plan := PlanRecoveryDrill(manifest.RecoveryScope, manifest, drilledAt)
	expected := uniqueSortedVersionsFromMetadata(manifest.Objects)
	actual := uniqueSortedVersions(verifiedVersions)
	if ValidateRecoveryManifest(manifest) != nil || plan.Kind != RecoveryDrillAccepted ||
		verifiedObjects != int64(len(manifest.Objects)) || !sameVersions(expected, actual) {
		return RecoveryDrillCompletion{Kind: RecoveryDrillInvalidEvidence}
	}
	receipt := RecoveryDrillReceipt{
		RecoveryScope: manifest.RecoveryScope, BackupID: manifest.BackupID,
		OperationID: manifest.Rotation.OperationID, SourceVersion: manifest.Rotation.SourceVersion,
		TargetVersion: manifest.Rotation.TargetVersion, CapturedAt: manifest.CapturedAt,
		DeleteAfter: manifest.DeleteAfter, DrilledAt: drilledAt, ObjectCount: verifiedObjects,
		VerifiedVersions: append([]cryptocontent.DEKVersion(nil), expected...),
	}
	return RecoveryDrillCompletion{Kind: RecoveryDrillVerified, Receipt: &receipt}
}

func EvaluateKeyRetirement(input KeyRetirementInput) KeyRetirementEvaluation {
	reasons := make(map[KeyRetirementBlockReason]struct{})
	if ValidateRecoveryScope(input.Scope) != nil || input.Rotation.AccountID != input.Scope.AccountID || input.Rotation.VaultID != input.Scope.VaultID {
		reasons[RetirementScopeMismatch] = struct{}{}
	}
	if !validTimestamp(input.EvaluatedAt) || input.EvaluatedAt < input.Rotation.UpdatedAtMilli {
		reasons[RetirementInvalidTimestamp] = struct{}{}
	}
	if _, completed := input.Rotation.State.(cryptocontent.RotationCompleted); !completed ||
		cryptocontent.ValidateRotationOperation(input.Rotation) != nil {
		reasons[RetirementRotationIncomplete] = struct{}{}
	}
	evaluateActiveRetirementInventory(input.ActiveInventory, reasons)
	evaluateRetirementBackups(input, reasons)
	evaluateRetirementDrill(input, reasons)
	if len(reasons) > 0 {
		ordered := make([]KeyRetirementBlockReason, 0, len(reasons))
		for reason := range reasons {
			ordered = append(ordered, reason)
		}
		sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
		return KeyRetirementEvaluation{Kind: KeyRetirementBlocked, Reasons: ordered}
	}
	return KeyRetirementEvaluation{
		Kind: KeyRetirementApprovalRequired, RecoveryScope: input.Scope,
		SourceVersion: input.Rotation.SourceVersion, TargetVersion: input.Rotation.TargetVersion,
		EvaluatedAt: input.EvaluatedAt, Approval: ExplicitKeyDestructionApproval,
	}
}

func recoveryTargetVersion(state RecoveryReencryptionState) (cryptocontent.DEKVersion, bool) {
	switch value := state.(type) {
	case RecoveryReencryptionCompleted:
		if _, err := cryptocontent.ParseDEKVersion(int64(value.TargetVersion)); err == nil {
			return value.TargetVersion, true
		}
	case RecoveryReencryptionPending:
		if _, err := cryptocontent.ParseDEKVersion(int64(value.TargetVersion)); err == nil {
			if value.After == nil || (ValidateObjectRef(value.After.Object) == nil && validateRevision(value.After.ObjectRevision) == nil) {
				return value.TargetVersion, false
			}
		}
	}
	return 0, false
}

func evaluateActiveRetirementInventory(
	inventory ReencryptionInventory,
	reasons map[KeyRetirementBlockReason]struct{},
) {
	counts := []int64{inventory.OlderObjects, inventory.TargetObjects, inventory.NewerObjects, inventory.OlderWriteIntents, inventory.NewerWriteIntents}
	if !inventory.OwnerPresent {
		reasons[RetirementIncompleteActive] = struct{}{}
		return
	}
	for _, count := range counts {
		if !validRecoveryCount(count) {
			reasons[RetirementIncompleteActive] = struct{}{}
			return
		}
	}
	if inventory.OlderObjects > 0 {
		reasons[RetirementActiveOldVersion] = struct{}{}
	}
	if inventory.OlderWriteIntents > 0 {
		reasons[RetirementPendingOldWrite] = struct{}{}
	}
	if inventory.NewerObjects > 0 || inventory.NewerWriteIntents > 0 {
		reasons[RetirementUnexpectedNewerVersion] = struct{}{}
	}
}

func evaluateRetirementBackups(input KeyRetirementInput, reasons map[KeyRetirementBlockReason]struct{}) {
	if !input.BackupInventoryComplete {
		reasons[RetirementIncompleteBackups] = struct{}{}
	}
	seen := make(map[RecoveryBackupID]struct{}, len(input.Backups))
	for _, backup := range input.Backups {
		_, duplicate := seen[backup.BackupID]
		if duplicate || backup.AccountID != input.Scope.AccountID || backup.VaultID != input.Scope.VaultID ||
			validateBackupReference(backup) != nil {
			reasons[RetirementInvalidBackup] = struct{}{}
			continue
		}
		seen[backup.BackupID] = struct{}{}
		if _, retained := backup.State.(BackupRetained); retained && containsVersion(backup.DEKVersions, input.Rotation.SourceVersion) {
			if input.EvaluatedAt > backup.DeleteAfter {
				reasons[RetirementBackupOverdue] = struct{}{}
			} else {
				reasons[RetirementRetainedBackup] = struct{}{}
			}
		}
	}
}

func evaluateRetirementDrill(input KeyRetirementInput, reasons map[KeyRetirementBlockReason]struct{}) {
	if input.DrillReceipt == nil {
		reasons[RetirementMissingDrill] = struct{}{}
		return
	}
	receipt := *input.DrillReceipt
	completed, ok := input.Rotation.State.(cryptocontent.RotationCompleted)
	completedAt := int64(identity.MaximumSafeInteger)
	if ok {
		completedAt = completed.CompletedAtMilli
	}
	if receipt.AccountID != input.Scope.AccountID || receipt.VaultID != input.Scope.VaultID ||
		receipt.OperationID != input.Rotation.OperationID || receipt.SourceVersion != input.Rotation.SourceVersion ||
		receipt.TargetVersion != input.Rotation.TargetVersion || validateDrillReceipt(receipt) != nil ||
		receipt.DrilledAt < completedAt || receipt.DrilledAt > input.EvaluatedAt ||
		!containsVersion(receipt.VerifiedVersions, input.Rotation.SourceVersion) ||
		!containsVersion(receipt.VerifiedVersions, input.Rotation.TargetVersion) {
		reasons[RetirementInvalidDrill] = struct{}{}
	}
}

func validateBackupReference(backup BackupRetentionReference) error {
	if ValidateRecoveryScope(backup.RecoveryScope) != nil || !backupIDPattern.MatchString(string(backup.BackupID)) ||
		!validTimestamp(backup.CapturedAt) || !validTimestamp(backup.DeleteAfter) ||
		backup.DeleteAfter < backup.CapturedAt || backup.DeleteAfter-backup.CapturedAt > MaximumBackupRetentionMilli {
		return ErrInvalidRecovery
	}
	seen := make(map[cryptocontent.DEKVersion]struct{}, len(backup.DEKVersions))
	for _, version := range backup.DEKVersions {
		if _, err := cryptocontent.ParseDEKVersion(int64(version)); err != nil {
			return ErrInvalidRecovery
		}
		if _, duplicate := seen[version]; duplicate {
			return ErrInvalidRecovery
		}
		seen[version] = struct{}{}
	}
	switch state := backup.State.(type) {
	case BackupRetained:
		return nil
	case BackupDeletionConfirmed:
		if !validTimestamp(state.DeletedAt) || state.DeletedAt < backup.CapturedAt || state.DeletedAt > backup.DeleteAfter {
			return ErrInvalidRecovery
		}
		return nil
	default:
		return ErrInvalidRecovery
	}
}

func validateDrillReceipt(receipt RecoveryDrillReceipt) error {
	if ValidateRecoveryScope(receipt.RecoveryScope) != nil || !backupIDPattern.MatchString(string(receipt.BackupID)) ||
		!validTimestamp(receipt.CapturedAt) || !validTimestamp(receipt.DeleteAfter) || !validTimestamp(receipt.DrilledAt) ||
		receipt.CapturedAt > receipt.DrilledAt || receipt.DrilledAt > receipt.DeleteAfter ||
		receipt.DeleteAfter-receipt.CapturedAt > MaximumBackupRetentionMilli || !validRecoveryCount(receipt.ObjectCount) {
		return ErrInvalidRecovery
	}
	if _, err := cryptocontent.ParseRotationOperationID(string(receipt.OperationID)); err != nil {
		return ErrInvalidRecovery
	}
	seen := make(map[cryptocontent.DEKVersion]struct{}, len(receipt.VerifiedVersions))
	for _, version := range receipt.VerifiedVersions {
		if _, err := cryptocontent.ParseDEKVersion(int64(version)); err != nil {
			return ErrInvalidRecovery
		}
		if _, duplicate := seen[version]; duplicate {
			return ErrInvalidRecovery
		}
		seen[version] = struct{}{}
	}
	return nil
}

func uniqueSortedVersionsFromMetadata(objects []Metadata) []cryptocontent.DEKVersion {
	versions := make([]cryptocontent.DEKVersion, 0, len(objects))
	for _, metadata := range objects {
		versions = append(versions, metadata.DEKVersion)
	}
	return uniqueSortedVersions(versions)
}

func uniqueSortedVersions(versions []cryptocontent.DEKVersion) []cryptocontent.DEKVersion {
	seen := make(map[cryptocontent.DEKVersion]struct{}, len(versions))
	result := make([]cryptocontent.DEKVersion, 0, len(versions))
	for _, version := range versions {
		if _, duplicate := seen[version]; duplicate {
			continue
		}
		seen[version] = struct{}{}
		result = append(result, version)
	}
	sort.Slice(result, func(left, right int) bool { return result[left] < result[right] })
	return result
}

func sameVersions(left, right []cryptocontent.DEKVersion) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func containsVersion(versions []cryptocontent.DEKVersion, expected cryptocontent.DEKVersion) bool {
	for _, version := range versions {
		if version == expected {
			return true
		}
	}
	return false
}

func validRecoveryCount(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}
