package encryptedobject

import (
	"sort"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

type WritePlanKind string

const (
	WritePlanReplay   WritePlanKind = "replay"
	WritePlanAccepted WritePlanKind = "accepted"
	WritePlanRejected WritePlanKind = "rejected"
)

type RejectionReason string

const (
	ReasonIdempotencyKeyReuse RejectionReason = "idempotency-key-reuse"
	ReasonUnexpectedExisting  RejectionReason = "unexpected-existing-object"
	ReasonMissingObject       RejectionReason = "missing-object"
	ReasonStaleRevision       RejectionReason = "stale-revision"
	ReasonInvalidNextRevision RejectionReason = "invalid-next-revision"
	ReasonInvalidTimeline     RejectionReason = "invalid-timeline"
	ReasonCiphertextLimit     RejectionReason = "ciphertext-limit"
	ReasonCASConflict         RejectionReason = "cas-conflict"
)

type WritePlan struct {
	Kind     WritePlanKind
	Metadata *Metadata
	Reason   RejectionReason
}

func PlanWrite(existingWrite, current *Metadata, request WriteRequest) WritePlan {
	if ValidateWriteRequest(request) != nil {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonInvalidNextRevision}
	}
	if existingWrite != nil {
		if ValidateMetadata(*existingWrite) == nil && metadataMatchesRequest(*existingWrite, request) {
			copyOfMetadata := *existingWrite
			return WritePlan{Kind: WritePlanReplay, Metadata: &copyOfMetadata}
		}
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonIdempotencyKeyReuse}
	}
	if current == nil {
		if request.ExpectedRevision != nil {
			return WritePlan{Kind: WritePlanRejected, Reason: ReasonMissingObject}
		}
		if request.NextRevision != 1 {
			return WritePlan{Kind: WritePlanRejected, Reason: ReasonInvalidNextRevision}
		}
		return WritePlan{Kind: WritePlanAccepted}
	}
	if ValidateMetadata(*current) != nil {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonStaleRevision}
	}
	if request.ExpectedRevision == nil {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonUnexpectedExisting}
	}
	if current.ObjectRevision != *request.ExpectedRevision {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonStaleRevision}
	}
	if int64(request.NextRevision) != int64(current.ObjectRevision)+1 {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonInvalidNextRevision}
	}
	if request.CreatedAtMilli < current.CreatedAtMilli {
		return WritePlan{Kind: WritePlanRejected, Reason: ReasonInvalidTimeline}
	}
	return WritePlan{Kind: WritePlanAccepted}
}

func PendingMatchesRequest(intent PendingWrite, request WriteRequest) bool {
	return ValidatePendingWrite(intent) == nil && ValidateWriteRequest(request) == nil &&
		intent.WriteID == request.WriteID && SameObject(intent.Object, request.Object) &&
		equalRevision(intent.ExpectedRevision, request.ExpectedRevision) &&
		intent.ObjectRevision == request.NextRevision && intent.PlaintextBytes == request.PlaintextBytes &&
		intent.DEKVersion == request.DEKVersion
}

func StoredCiphertextMatches(
	cryptoVersion string,
	dekVersion cryptocontent.DEKVersion,
	expectedBytes *int64,
	ciphertext cryptocontent.EnvelopeCiphertext,
	actualBytes int64,
) bool {
	if expectedBytes != nil && *expectedBytes != actualBytes {
		return false
	}
	return cryptoVersion == ciphertext.Format && dekVersion == ciphertext.DEKVersion
}

func PlanOrphanCollection(
	stored []PrivateObjectDescriptor,
	protected map[ObjectKey]struct{},
	scanStartedAt int64,
	gracePeriodMilli int64,
) []ObjectKey {
	if !validTimestamp(scanStartedAt) || gracePeriodMilli < 0 || gracePeriodMilli > identityMaximumSafeInteger {
		return nil
	}
	cutoff := scanStartedAt - gracePeriodMilli
	result := make([]ObjectKey, 0)
	for _, descriptor := range stored {
		if validateObjectKey(descriptor.ObjectKey) != nil || !validTimestamp(descriptor.CreatedAtMilli) {
			continue
		}
		if _, keep := protected[descriptor.ObjectKey]; !keep && descriptor.CreatedAtMilli <= cutoff {
			result = append(result, descriptor.ObjectKey)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left] < result[right] })
	return result
}

func PlanDeleteAttempt(entry DeleteOutboxEntry, succeeded bool, attemptedAt, retryDelayMilli int64) (DeleteOutboxEntry, bool) {
	if succeeded {
		return entry, true
	}
	retry := entry
	retry.AttemptCount++
	retry.NextAttemptAt = attemptedAt + retryDelayMilli
	return retry, false
}

func SameObject(left, right ObjectRef) bool {
	return left.Kind == right.Kind && left.ObjectID == right.ObjectID
}

func metadataMatchesRequest(metadata Metadata, request WriteRequest) bool {
	return metadata.WriteID == request.WriteID && SameObject(metadata.Object, request.Object) &&
		metadata.ObjectRevision == request.NextRevision && metadata.PlaintextBytes == request.PlaintextBytes
}

func equalRevision(left, right *cryptocontent.ObjectRevision) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

const identityMaximumSafeInteger = int64(9_007_199_254_740_991)
