package cryptocontent

import (
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

var (
	ErrInvalidRotation = errors.New("invalid DEK rotation value")
	rotationIDPattern  = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
)

type RotationOperationID string
type RotationRevision int64

type RotationScope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type RotationState interface {
	isRotationState()
}

type RotationGenerating struct{}

type RotationPromoting struct {
	Metadata VaultDEKMetadata
}

type RotationCompleted struct {
	Metadata         VaultDEKMetadata
	CompletedAtMilli int64
}

func (RotationGenerating) isRotationState() {}
func (RotationPromoting) isRotationState()  {}
func (RotationCompleted) isRotationState()  {}

type RotationOperation struct {
	RotationScope
	OperationID    RotationOperationID
	Revision       RotationRevision
	SourceVersion  DEKVersion
	TargetVersion  DEKVersion
	State          RotationState
	CreatedAtMilli int64
	UpdatedAtMilli int64
}

type RotationSnapshot struct {
	Keyring   VaultDEKKeyring
	Operation *RotationOperation
}

type RotationStartKind string

const (
	RotationStartAccepted RotationStartKind = "accepted"
	RotationStartReplayed RotationStartKind = "replayed"
	RotationStartRejected RotationStartKind = "rejected"
)

type RotationRejection string

const (
	RotationActive          RotationRejection = "active-rotation"
	RotationInvalidSnapshot RotationRejection = "invalid-snapshot"
	RotationInvalidTime     RotationRejection = "invalid-timestamp"
	RotationVersionLimit    RotationRejection = "version-limit"
	RotationVaultMismatch   RotationRejection = "vault-mismatch"
	RotationInvalidMetadata RotationRejection = "invalid-metadata"
	RotationRevisionLimit   RotationRejection = "revision-limit"
	RotationWrongState      RotationRejection = "wrong-state"
)

type RotationStartPlan struct {
	Kind    RotationStartKind
	Current *RotationOperation
	Next    *RotationOperation
	Reason  RotationRejection
}

type RotationTransition struct {
	Current RotationOperation
	Next    RotationOperation
}

type RotationTransitionPlan struct {
	Accepted   bool
	Transition RotationTransition
	Reason     RotationRejection
}

func ParseRotationOperationID(value string) (RotationOperationID, error) {
	if !rotationIDPattern.MatchString(value) {
		return "", ErrInvalidRotation
	}
	return RotationOperationID(value), nil
}

func PlanRotationStart(
	scope RotationScope,
	keyring VaultDEKKeyring,
	current *RotationOperation,
	operationID RotationOperationID,
	requestedAtMilli int64,
) RotationStartPlan {
	if ValidateRotationScope(scope) != nil || ValidateVaultDEKKeyring(keyring) != nil ||
		!rotationIDPattern.MatchString(string(operationID)) {
		return rejectedRotationStart(RotationInvalidSnapshot)
	}
	if keyring.VaultID != scope.VaultID {
		return rejectedRotationStart(RotationVaultMismatch)
	}
	if !validRotationTimestamp(requestedAtMilli) {
		return rejectedRotationStart(RotationInvalidTime)
	}
	if current != nil {
		if current.AccountID != scope.AccountID || current.VaultID != scope.VaultID ||
			!ValidRotationSnapshot(RotationSnapshot{Keyring: keyring, Operation: current}) {
			return rejectedRotationStart(RotationInvalidSnapshot)
		}
		if current.OperationID == operationID {
			copyOfCurrent := cloneRotationOperation(*current)
			return RotationStartPlan{Kind: RotationStartReplayed, Current: &copyOfCurrent}
		}
		if _, completed := current.State.(RotationCompleted); !completed {
			return rejectedRotationStart(RotationActive)
		}
		if requestedAtMilli < current.UpdatedAtMilli {
			return rejectedRotationStart(RotationInvalidTime)
		}
	}
	if int64(keyring.WriteVersion) >= MaximumDEKVersion {
		return rejectedRotationStart(RotationVersionLimit)
	}
	target, err := ParseDEKVersion(int64(keyring.WriteVersion) + 1)
	if err != nil {
		return rejectedRotationStart(RotationVersionLimit)
	}
	next := RotationOperation{
		RotationScope: scope, OperationID: operationID, Revision: 1,
		SourceVersion: keyring.WriteVersion, TargetVersion: target,
		State: RotationGenerating{}, CreatedAtMilli: requestedAtMilli, UpdatedAtMilli: requestedAtMilli,
	}
	var copiedCurrent *RotationOperation
	if current != nil {
		copyOfCurrent := cloneRotationOperation(*current)
		copiedCurrent = &copyOfCurrent
	}
	return RotationStartPlan{Kind: RotationStartAccepted, Current: copiedCurrent, Next: &next}
}

func PlanRotationGenerated(
	operation RotationOperation,
	metadata VaultDEKMetadata,
	generatedAtMilli int64,
) RotationTransitionPlan {
	if _, ok := operation.State.(RotationGenerating); !ok {
		return rejectedRotationTransition(RotationWrongState)
	}
	if !validRotationTimestamp(generatedAtMilli) || generatedAtMilli < operation.UpdatedAtMilli {
		return rejectedRotationTransition(RotationInvalidTime)
	}
	if ValidateVaultDEKMetadata(metadata) != nil || metadata.VaultID != operation.VaultID ||
		metadata.DEKVersion != operation.TargetVersion || metadata.CreatedAtMilli < operation.CreatedAtMilli ||
		metadata.CreatedAtMilli > generatedAtMilli {
		return rejectedRotationTransition(RotationInvalidMetadata)
	}
	return advanceRotation(operation, RotationPromoting{Metadata: metadata}, generatedAtMilli)
}

func PlanRotationPromotion(
	operation RotationOperation,
	keyring VaultDEKKeyring,
	completedAtMilli int64,
) RotationTransitionPlan {
	promoting, ok := operation.State.(RotationPromoting)
	if !ok {
		return rejectedRotationTransition(RotationWrongState)
	}
	if !validRotationTimestamp(completedAtMilli) || completedAtMilli < operation.UpdatedAtMilli {
		return rejectedRotationTransition(RotationInvalidTime)
	}
	if !ValidRotationSnapshot(RotationSnapshot{Keyring: keyring, Operation: &operation}) {
		return rejectedRotationTransition(RotationInvalidSnapshot)
	}
	return advanceRotation(operation, RotationCompleted{
		Metadata: promoting.Metadata, CompletedAtMilli: completedAtMilli,
	}, completedAtMilli)
}

func ValidateRotationScope(scope RotationScope) error {
	if _, err := identity.ParseAccountID(string(scope.AccountID)); err != nil {
		return ErrInvalidRotation
	}
	if _, err := identity.ParseVaultID(string(scope.VaultID)); err != nil {
		return ErrInvalidRotation
	}
	return nil
}

func ValidateRotationOperation(operation RotationOperation) error {
	if ValidateRotationScope(operation.RotationScope) != nil || !rotationIDPattern.MatchString(string(operation.OperationID)) ||
		operation.Revision < 1 || int64(operation.Revision) > MaximumDEKVersion ||
		operation.TargetVersion != operation.SourceVersion+1 || !validRotationTimestamp(operation.CreatedAtMilli) ||
		!validRotationTimestamp(operation.UpdatedAtMilli) || operation.UpdatedAtMilli < operation.CreatedAtMilli {
		return ErrInvalidRotation
	}
	switch state := operation.State.(type) {
	case RotationGenerating:
		if operation.Revision != 1 {
			return ErrInvalidRotation
		}
	case RotationPromoting:
		if operation.Revision != 2 || !rotationMetadataMatches(operation, state.Metadata) {
			return ErrInvalidRotation
		}
	case RotationCompleted:
		if operation.Revision != 3 || state.CompletedAtMilli != operation.UpdatedAtMilli ||
			!rotationMetadataMatches(operation, state.Metadata) {
			return ErrInvalidRotation
		}
	default:
		return ErrInvalidRotation
	}
	return nil
}

func ValidRotationSnapshot(snapshot RotationSnapshot) bool {
	if ValidateVaultDEKKeyring(snapshot.Keyring) != nil {
		return false
	}
	if snapshot.Operation == nil {
		return true
	}
	operation := *snapshot.Operation
	if ValidateRotationOperation(operation) != nil || operation.VaultID != snapshot.Keyring.VaultID {
		return false
	}
	writeVersion := operation.SourceVersion
	if _, completed := operation.State.(RotationCompleted); completed {
		writeVersion = operation.TargetVersion
	}
	if snapshot.Keyring.WriteVersion != writeVersion {
		return false
	}
	var expected *VaultDEKMetadata
	switch state := operation.State.(type) {
	case RotationPromoting:
		value := state.Metadata
		expected = &value
	case RotationCompleted:
		value := state.Metadata
		expected = &value
	}
	var target *VaultDEKMetadata
	for index := range snapshot.Keyring.Versions {
		if snapshot.Keyring.Versions[index].DEKVersion == operation.TargetVersion {
			value := snapshot.Keyring.Versions[index]
			target = &value
			break
		}
	}
	if expected == nil {
		return target == nil
	}
	if target != nil && !SameVaultDEKMetadata(*target, *expected) {
		return false
	}
	_, completed := operation.State.(RotationCompleted)
	return !completed || target != nil
}

func ValidRotationTransition(transition RotationTransition) bool {
	current, next := transition.Current, transition.Next
	if ValidateRotationOperation(current) != nil || ValidateRotationOperation(next) != nil ||
		current.OperationID != next.OperationID || current.RotationScope != next.RotationScope ||
		current.SourceVersion != next.SourceVersion || current.TargetVersion != next.TargetVersion ||
		current.CreatedAtMilli != next.CreatedAtMilli || next.Revision != current.Revision+1 ||
		next.UpdatedAtMilli < current.UpdatedAtMilli {
		return false
	}
	switch current.State.(type) {
	case RotationGenerating:
		_, ok := next.State.(RotationPromoting)
		return ok
	case RotationPromoting:
		_, ok := next.State.(RotationCompleted)
		return ok
	default:
		return false
	}
}

func SameRotationOperation(left, right RotationOperation) bool {
	if left.OperationID != right.OperationID || left.RotationScope != right.RotationScope || left.Revision != right.Revision ||
		left.SourceVersion != right.SourceVersion || left.TargetVersion != right.TargetVersion ||
		left.CreatedAtMilli != right.CreatedAtMilli || left.UpdatedAtMilli != right.UpdatedAtMilli {
		return false
	}
	switch leftState := left.State.(type) {
	case RotationGenerating:
		_, ok := right.State.(RotationGenerating)
		return ok
	case RotationPromoting:
		rightState, ok := right.State.(RotationPromoting)
		return ok && SameVaultDEKMetadata(leftState.Metadata, rightState.Metadata)
	case RotationCompleted:
		rightState, ok := right.State.(RotationCompleted)
		return ok && leftState.CompletedAtMilli == rightState.CompletedAtMilli &&
			SameVaultDEKMetadata(leftState.Metadata, rightState.Metadata)
	default:
		return false
	}
}

func SameVaultDEKMetadata(left, right VaultDEKMetadata) bool {
	return left == right
}

func ValidateVaultDEKKeyring(keyring VaultDEKKeyring) error {
	_, err := NewVaultDEKKeyring(keyring.VaultID, keyring.WriteVersion, keyring.Versions)
	return err
}

func advanceRotation(operation RotationOperation, state RotationState, updatedAtMilli int64) RotationTransitionPlan {
	if operation.Revision >= RotationRevision(MaximumDEKVersion) {
		return rejectedRotationTransition(RotationRevisionLimit)
	}
	next := cloneRotationOperation(operation)
	next.Revision++
	next.State = state
	next.UpdatedAtMilli = updatedAtMilli
	transition := RotationTransition{Current: cloneRotationOperation(operation), Next: next}
	if !ValidRotationTransition(transition) {
		return rejectedRotationTransition(RotationInvalidSnapshot)
	}
	return RotationTransitionPlan{Accepted: true, Transition: transition}
}

func rotationMetadataMatches(operation RotationOperation, metadata VaultDEKMetadata) bool {
	return ValidateVaultDEKMetadata(metadata) == nil && metadata.VaultID == operation.VaultID &&
		metadata.DEKVersion == operation.TargetVersion && metadata.CreatedAtMilli >= operation.CreatedAtMilli &&
		metadata.CreatedAtMilli <= operation.UpdatedAtMilli
}

func cloneRotationOperation(operation RotationOperation) RotationOperation {
	switch state := operation.State.(type) {
	case RotationGenerating:
		operation.State = RotationGenerating{}
	case RotationPromoting:
		operation.State = RotationPromoting{Metadata: state.Metadata}
	case RotationCompleted:
		operation.State = RotationCompleted{Metadata: state.Metadata, CompletedAtMilli: state.CompletedAtMilli}
	}
	return operation
}

func validRotationTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}

func rejectedRotationStart(reason RotationRejection) RotationStartPlan {
	return RotationStartPlan{Kind: RotationStartRejected, Reason: reason}
}

func rejectedRotationTransition(reason RotationRejection) RotationTransitionPlan {
	return RotationTransitionPlan{Reason: reason}
}
