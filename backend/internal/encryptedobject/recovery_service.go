package encryptedobject

import (
	"context"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

type RecoveryBackupPort interface {
	LoadManifest(context.Context, RecoveryScope) ([]byte, error)
	LoadCiphertext(context.Context, RecoveryBackupID, ObjectKey) ([]byte, bool, error)
}

type RecoveryDrillResultKind string

const (
	RecoveryResultVerified RecoveryDrillResultKind = "verified"
	RecoveryResultBlocked  RecoveryDrillResultKind = "blocked"
)

type RecoveryDrillResultReason string

const (
	RecoveryInvalidManifest       RecoveryDrillResultReason = "invalid-manifest"
	RecoveryBackupUnavailable     RecoveryDrillResultReason = "backup-unavailable"
	RecoveryResultScopeMismatch   RecoveryDrillResultReason = "scope-mismatch"
	RecoveryResultInvalidTime     RecoveryDrillResultReason = "invalid-timestamp"
	RecoveryResultExpired         RecoveryDrillResultReason = "retention-expired"
	RecoveryResultRotation        RecoveryDrillResultReason = "rotation-incomplete"
	RecoveryResultCheckpoint      RecoveryDrillResultReason = "incomplete-checkpoint"
	RecoveryMissingObject         RecoveryDrillResultReason = "missing-object"
	RecoveryInvalidCiphertext     RecoveryDrillResultReason = "invalid-ciphertext"
	RecoveryAuthenticationFailed  RecoveryDrillResultReason = "authentication-failed"
	RecoveryResultInvalidEvidence RecoveryDrillResultReason = "invalid-evidence"
)

type RecoveryDrillResult struct {
	Kind    RecoveryDrillResultKind   `json:"kind"`
	Reason  RecoveryDrillResultReason `json:"reason,omitempty"`
	Receipt *RecoveryDrillReceipt     `json:"receipt,omitempty"`
}

type RecoveryDrillService struct {
	backup     RecoveryBackupPort
	encryption EncryptionPort
}

func NewRecoveryDrillService(backup RecoveryBackupPort, encryption EncryptionPort) (*RecoveryDrillService, error) {
	if backup == nil || encryption == nil {
		return nil, ErrInvalidRecovery
	}
	return &RecoveryDrillService{backup: backup, encryption: encryption}, nil
}

func (service *RecoveryDrillService) Run(
	ctx context.Context,
	scope RecoveryScope,
	drilledAt int64,
) RecoveryDrillResult {
	if service == nil || service.backup == nil || service.encryption == nil || ValidateRecoveryScope(scope) != nil {
		return blockedRecoveryResult(RecoveryInvalidManifest)
	}
	manifestBytes, err := service.backup.LoadManifest(ctx, scope)
	if err != nil {
		return blockedRecoveryResult(RecoveryBackupUnavailable)
	}
	manifest, err := DecodeRecoveryManifest(manifestBytes)
	clear(manifestBytes)
	if err != nil {
		return blockedRecoveryResult(RecoveryInvalidManifest)
	}
	plan := PlanRecoveryDrill(scope, manifest, drilledAt)
	if plan.Kind == RecoveryDrillBlocked {
		return blockedRecoveryResult(resultReasonForPlan(plan.Reason))
	}
	verifiedVersions := make([]cryptocontent.DEKVersion, 0, len(manifest.Objects))
	verifiedObjects := int64(0)
	for _, metadata := range manifest.Objects {
		encoded, found, err := service.backup.LoadCiphertext(ctx, manifest.BackupID, metadata.ObjectKey)
		if err != nil {
			return blockedRecoveryResult(RecoveryBackupUnavailable)
		}
		if !found {
			return blockedRecoveryResult(RecoveryMissingObject)
		}
		actualBytes := int64(len(encoded))
		ciphertext, err := cryptocontent.DecodeEnvelopeCiphertext(encoded)
		clear(encoded)
		if err != nil || !StoredCiphertextMatches(
			metadata.CryptoVersion,
			metadata.DEKVersion,
			&metadata.CiphertextBytes,
			ciphertext,
			actualBytes,
		) {
			return blockedRecoveryResult(RecoveryInvalidCiphertext)
		}
		plaintext, err := service.encryption.Decrypt(ctx, manifest.Keyring, cryptocontent.ObjectContext{
			VaultID: manifest.VaultID, Kind: metadata.Object.Kind, ObjectID: metadata.Object.ObjectID,
			ObjectRevision: metadata.ObjectRevision,
		}, ciphertext)
		if err != nil {
			clear(plaintext)
			return blockedRecoveryResult(RecoveryAuthenticationFailed)
		}
		plaintextBytes := int64(len(plaintext))
		clear(plaintext)
		if plaintextBytes != metadata.PlaintextBytes {
			return blockedRecoveryResult(RecoveryInvalidCiphertext)
		}
		verifiedObjects++
		verifiedVersions = append(verifiedVersions, metadata.DEKVersion)
	}
	completion := CompleteRecoveryDrill(manifest, drilledAt, verifiedObjects, verifiedVersions)
	if completion.Kind != RecoveryDrillVerified || completion.Receipt == nil {
		return blockedRecoveryResult(RecoveryResultInvalidEvidence)
	}
	return RecoveryDrillResult{Kind: RecoveryResultVerified, Receipt: completion.Receipt}
}

func blockedRecoveryResult(reason RecoveryDrillResultReason) RecoveryDrillResult {
	return RecoveryDrillResult{Kind: RecoveryResultBlocked, Reason: reason}
}

func resultReasonForPlan(reason RecoveryDrillBlockReason) RecoveryDrillResultReason {
	switch reason {
	case RecoveryScopeMismatch:
		return RecoveryResultScopeMismatch
	case RecoveryInvalidTimestamp:
		return RecoveryResultInvalidTime
	case RecoveryRetentionExpired:
		return RecoveryResultExpired
	case RecoveryRotationIncomplete:
		return RecoveryResultRotation
	case RecoveryCheckpointIncomplete:
		return RecoveryResultCheckpoint
	default:
		return RecoveryResultInvalidEvidence
	}
}
