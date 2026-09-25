package encryptedobject

import (
	"sort"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

const MaximumReencryptionBatchSize = 100

type ReencryptionPosition struct {
	Object         ObjectRef
	ObjectRevision cryptocontent.ObjectRevision
}

type ReencryptionJobState string

const (
	ReencryptionRunning   ReencryptionJobState = "running"
	ReencryptionCompleted ReencryptionJobState = "completed"
)

type ReencryptionJob struct {
	TargetVersion  cryptocontent.DEKVersion
	After          *ReencryptionPosition
	State          ReencryptionJobState
	Revision       int64
	CreatedAtMilli int64
	UpdatedAtMilli int64
}

type ReencryptionInventory struct {
	OwnerPresent      bool
	OlderObjects      int64
	TargetObjects     int64
	NewerObjects      int64
	OlderWriteIntents int64
	NewerWriteIntents int64
}

type ReencryptionInventoryKind string

const (
	ReencryptionInventoryScan     ReencryptionInventoryKind = "scan"
	ReencryptionInventoryWait     ReencryptionInventoryKind = "wait-for-pending-writes"
	ReencryptionInventoryComplete ReencryptionInventoryKind = "completed"
	ReencryptionInventoryReject   ReencryptionInventoryKind = "rejected"
)

type ReencryptionRejection string

const (
	ReencryptionVaultMismatch   ReencryptionRejection = "vault-mismatch"
	ReencryptionInvalidLimit    ReencryptionRejection = "invalid-limit"
	ReencryptionInvalidTime     ReencryptionRejection = "invalid-timestamp"
	ReencryptionOwnerMissing    ReencryptionRejection = "owner-not-found"
	ReencryptionBadInventory    ReencryptionRejection = "invalid-inventory"
	ReencryptionNewerVersion    ReencryptionRejection = "newer-version"
	ReencryptionTargetMismatch  ReencryptionRejection = "checkpoint-target-mismatch"
	ReencryptionCandidateNew    ReencryptionRejection = "candidate-not-older"
	ReencryptionObjectKeyReuse  ReencryptionRejection = "object-key-reuse"
	ReencryptionCiphertextLimit ReencryptionRejection = "invalid-ciphertext-size"
)

type ReencryptionInventoryPlan struct {
	Kind   ReencryptionInventoryKind
	Reason ReencryptionRejection
}

type ReencryptionCandidatePlan struct {
	Accepted    bool
	Replacement Metadata
	Reason      ReencryptionRejection
}

func ValidateReencryptionJob(job ReencryptionJob) error {
	if _, err := cryptocontent.ParseDEKVersion(int64(job.TargetVersion)); err != nil {
		return ErrInvalidValue
	}
	if job.State != ReencryptionRunning && job.State != ReencryptionCompleted {
		return ErrInvalidValue
	}
	if job.Revision < 1 || job.Revision > cryptocontent.MaximumDEKVersion ||
		!validTimestamp(job.CreatedAtMilli) || !validTimestamp(job.UpdatedAtMilli) ||
		job.UpdatedAtMilli < job.CreatedAtMilli {
		return ErrInvalidValue
	}
	if job.After != nil {
		if ValidateObjectRef(job.After.Object) != nil || validateRevision(job.After.ObjectRevision) != nil ||
			job.State == ReencryptionCompleted {
			return ErrInvalidValue
		}
	}
	return nil
}

func AdvanceReencryptionJob(
	job ReencryptionJob,
	after *ReencryptionPosition,
	state ReencryptionJobState,
	updatedAtMilli int64,
) (ReencryptionJob, error) {
	if ValidateReencryptionJob(job) != nil || job.State != ReencryptionRunning ||
		job.Revision >= cryptocontent.MaximumDEKVersion || !validTimestamp(updatedAtMilli) ||
		updatedAtMilli < job.UpdatedAtMilli || (state != ReencryptionRunning && state != ReencryptionCompleted) {
		return ReencryptionJob{}, ErrInvalidValue
	}
	next := job
	next.Revision++
	next.State = state
	next.UpdatedAtMilli = updatedAtMilli
	next.After = nil
	if after != nil {
		copyOfAfter := *after
		next.After = &copyOfAfter
	}
	if ValidateReencryptionJob(next) != nil {
		return ReencryptionJob{}, ErrInvalidValue
	}
	return next, nil
}

func ValidReencryptionJobTransition(current, next ReencryptionJob) bool {
	if ValidateReencryptionJob(current) != nil || ValidateReencryptionJob(next) != nil ||
		current.State != ReencryptionRunning || current.TargetVersion != next.TargetVersion ||
		current.CreatedAtMilli != next.CreatedAtMilli || next.Revision != current.Revision+1 ||
		next.UpdatedAtMilli < current.UpdatedAtMilli {
		return false
	}
	return next.State == ReencryptionRunning ||
		(next.State == ReencryptionCompleted && next.After == nil)
}

func EvaluateReencryptionInventory(inventory ReencryptionInventory) ReencryptionInventoryPlan {
	if !inventory.OwnerPresent {
		return ReencryptionInventoryPlan{Kind: ReencryptionInventoryReject, Reason: ReencryptionOwnerMissing}
	}
	counts := []int64{
		inventory.OlderObjects, inventory.TargetObjects, inventory.NewerObjects,
		inventory.OlderWriteIntents, inventory.NewerWriteIntents,
	}
	for _, count := range counts {
		if count < 0 {
			return ReencryptionInventoryPlan{Kind: ReencryptionInventoryReject, Reason: ReencryptionBadInventory}
		}
	}
	if inventory.NewerObjects > 0 || inventory.NewerWriteIntents > 0 {
		return ReencryptionInventoryPlan{Kind: ReencryptionInventoryReject, Reason: ReencryptionNewerVersion}
	}
	if inventory.OlderObjects > 0 {
		return ReencryptionInventoryPlan{Kind: ReencryptionInventoryScan}
	}
	if inventory.OlderWriteIntents > 0 {
		return ReencryptionInventoryPlan{Kind: ReencryptionInventoryWait}
	}
	return ReencryptionInventoryPlan{Kind: ReencryptionInventoryComplete}
}

func PlanReencryptionCandidate(
	candidate Metadata,
	targetVersion cryptocontent.DEKVersion,
	replacementObjectKey ObjectKey,
	replacementCiphertextBytes int64,
) ReencryptionCandidatePlan {
	if ValidateMetadata(candidate) != nil {
		return ReencryptionCandidatePlan{Reason: ReencryptionCandidateNew}
	}
	if candidate.DEKVersion >= targetVersion {
		return ReencryptionCandidatePlan{Reason: ReencryptionCandidateNew}
	}
	if candidate.ObjectKey == replacementObjectKey {
		return ReencryptionCandidatePlan{Reason: ReencryptionObjectKeyReuse}
	}
	if replacementCiphertextBytes < 1 || replacementCiphertextBytes > MaximumStoredBytes {
		return ReencryptionCandidatePlan{Reason: ReencryptionCiphertextLimit}
	}
	replacement := candidate
	replacement.ObjectKey = replacementObjectKey
	replacement.CiphertextBytes = replacementCiphertextBytes
	replacement.DEKVersion = targetVersion
	if ValidateMetadata(replacement) != nil {
		return ReencryptionCandidatePlan{Reason: ReencryptionCiphertextLimit}
	}
	return ReencryptionCandidatePlan{Accepted: true, Replacement: replacement}
}

func PositionFor(metadata Metadata) ReencryptionPosition {
	return ReencryptionPosition{Object: metadata.Object, ObjectRevision: metadata.ObjectRevision}
}

func SameMetadata(left, right Metadata) bool {
	return SameObject(left.Object, right.Object) && left.ObjectRevision == right.ObjectRevision &&
		left.WriteID == right.WriteID && left.ObjectKey == right.ObjectKey &&
		left.PlaintextBytes == right.PlaintextBytes && left.CiphertextBytes == right.CiphertextBytes &&
		left.CryptoVersion == right.CryptoVersion && left.DEKVersion == right.DEKVersion &&
		left.CreatedAtMilli == right.CreatedAtMilli
}

func CompareReencryptionPosition(left, right ReencryptionPosition) int {
	if left.Object.Kind != right.Object.Kind {
		if left.Object.Kind < right.Object.Kind {
			return -1
		}
		return 1
	}
	if left.Object.ObjectID != right.Object.ObjectID {
		if left.Object.ObjectID < right.Object.ObjectID {
			return -1
		}
		return 1
	}
	if left.ObjectRevision < right.ObjectRevision {
		return -1
	}
	if left.ObjectRevision > right.ObjectRevision {
		return 1
	}
	return 0
}

func SortReencryptionCandidates(values []Metadata) {
	sort.Slice(values, func(left, right int) bool {
		return CompareReencryptionPosition(PositionFor(values[left]), PositionFor(values[right])) < 0
	})
}
