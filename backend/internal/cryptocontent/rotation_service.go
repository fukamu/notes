package cryptocontent

import (
	"context"
	"errors"
)

var ErrRotationService = errors.New("invalid DEK rotation service operation")

type RotationLoadKind string

const (
	RotationFound    RotationLoadKind = "found"
	RotationNotFound RotationLoadKind = "not-found"
)

type RotationLoadResult struct {
	Kind     RotationLoadKind
	Snapshot RotationSnapshot
}

type RotationCommitKind string

const (
	RotationApplied  RotationCommitKind = "applied"
	RotationReplayed RotationCommitKind = "replayed"
	RotationConflict RotationCommitKind = "conflict"
)

type RotationCommitResult struct {
	Kind     RotationCommitKind
	Snapshot *RotationSnapshot
}

type RotationRepository interface {
	Load(context.Context, RotationScope) (RotationLoadResult, error)
	Start(context.Context, RotationScope, RotationStartPlan) (RotationCommitResult, error)
	RecordGenerated(context.Context, RotationScope, RotationTransition) (RotationCommitResult, error)
	Promote(context.Context, RotationScope, RotationTransition) (RotationCommitResult, error)
}

type RotationRunKind string

const (
	RotationPending   RotationRunKind = "pending"
	RotationFinished  RotationRunKind = "completed"
	RotationRunReject RotationRunKind = "rejected"
)

type RotationRunRejection string

const (
	RotationRunConflict     RotationRunRejection = "conflict"
	RotationRunInvalidState RotationRunRejection = "invalid-state"
	RotationRunNotFound     RotationRunRejection = "not-found"
)

type RotationRunResult struct {
	Kind      RotationRunKind
	Operation *RotationOperation
	Reason    RotationRunRejection
}

type RotationService struct {
	repository RotationRepository
	keys       KeyManagementPort
}

func NewRotationService(repository RotationRepository, keys KeyManagementPort) (*RotationService, error) {
	if repository == nil || keys == nil {
		return nil, ErrRotationService
	}
	return &RotationService{repository: repository, keys: keys}, nil
}

func (service *RotationService) Start(
	ctx context.Context,
	scope RotationScope,
	operationID RotationOperationID,
	requestedAtMilli int64,
) (RotationRunResult, error) {
	if service == nil || service.repository == nil || service.keys == nil || ValidateRotationScope(scope) != nil {
		return RotationRunResult{}, ErrRotationService
	}
	loaded, err := service.repository.Load(ctx, scope)
	if err != nil {
		return RotationRunResult{}, err
	}
	if loaded.Kind == RotationNotFound {
		return rejectedRotationRun(RotationRunNotFound), nil
	}
	if loaded.Kind != RotationFound || !ValidRotationSnapshot(loaded.Snapshot) {
		return RotationRunResult{}, ErrRotationService
	}
	plan := PlanRotationStart(scope, loaded.Snapshot.Keyring, loaded.Snapshot.Operation, operationID, requestedAtMilli)
	switch plan.Kind {
	case RotationStartReplayed:
		if plan.Current == nil {
			return RotationRunResult{}, ErrRotationService
		}
		return rotationResultFor(*plan.Current), nil
	case RotationStartRejected:
		return rejectedRotationRun(RotationRunInvalidState), nil
	case RotationStartAccepted:
		commit, commitErr := service.repository.Start(ctx, scope, plan)
		if commitErr != nil {
			return RotationRunResult{}, commitErr
		}
		return rotationCommitResult(commit)
	default:
		return RotationRunResult{}, ErrRotationService
	}
}

func (service *RotationService) Resume(
	ctx context.Context,
	scope RotationScope,
	operationID RotationOperationID,
	performedAtMilli int64,
) (RotationRunResult, error) {
	if service == nil || service.repository == nil || service.keys == nil || ValidateRotationScope(scope) != nil ||
		!rotationIDPattern.MatchString(string(operationID)) || !validRotationTimestamp(performedAtMilli) {
		return RotationRunResult{}, ErrRotationService
	}
	loaded, err := service.repository.Load(ctx, scope)
	if err != nil {
		return RotationRunResult{}, err
	}
	if loaded.Kind == RotationNotFound {
		return rejectedRotationRun(RotationRunNotFound), nil
	}
	operation := loaded.Snapshot.Operation
	if loaded.Kind != RotationFound || !ValidRotationSnapshot(loaded.Snapshot) || operation == nil ||
		operation.OperationID != operationID {
		return rejectedRotationRun(RotationRunNotFound), nil
	}
	switch operation.State.(type) {
	case RotationGenerating:
		metadata, key, generateErr := service.keys.GenerateDataKey(ctx, scope.VaultID, operation.TargetVersion)
		if generateErr != nil {
			if key != nil {
				key.Destroy()
			}
			return RotationRunResult{}, generateErr
		}
		if key == nil {
			return RotationRunResult{}, ErrRotationService
		}
		defer key.Destroy()
		plan := PlanRotationGenerated(*operation, metadata, performedAtMilli)
		if !plan.Accepted {
			return rejectedRotationRun(RotationRunInvalidState), nil
		}
		commit, commitErr := service.repository.RecordGenerated(ctx, scope, plan.Transition)
		if commitErr != nil {
			return RotationRunResult{}, commitErr
		}
		return rotationCommitResult(commit)
	case RotationPromoting:
		plan := PlanRotationPromotion(*operation, loaded.Snapshot.Keyring, performedAtMilli)
		if !plan.Accepted {
			return rejectedRotationRun(RotationRunInvalidState), nil
		}
		commit, commitErr := service.repository.Promote(ctx, scope, plan.Transition)
		if commitErr != nil {
			return RotationRunResult{}, commitErr
		}
		return rotationCommitResult(commit)
	case RotationCompleted:
		return rotationResultFor(*operation), nil
	default:
		return RotationRunResult{}, ErrRotationService
	}
}

func rotationCommitResult(commit RotationCommitResult) (RotationRunResult, error) {
	switch commit.Kind {
	case RotationApplied, RotationReplayed:
		if commit.Snapshot == nil || commit.Snapshot.Operation == nil || !ValidRotationSnapshot(*commit.Snapshot) {
			return RotationRunResult{}, ErrRotationService
		}
		return rotationResultFor(*commit.Snapshot.Operation), nil
	case RotationConflict:
		return rejectedRotationRun(RotationRunConflict), nil
	default:
		return RotationRunResult{}, ErrRotationService
	}
}

func rotationResultFor(operation RotationOperation) RotationRunResult {
	copyOfOperation := cloneRotationOperation(operation)
	if _, completed := operation.State.(RotationCompleted); completed {
		return RotationRunResult{Kind: RotationFinished, Operation: &copyOfOperation}
	}
	return RotationRunResult{Kind: RotationPending, Operation: &copyOfOperation}
}

func rejectedRotationRun(reason RotationRunRejection) RotationRunResult {
	return RotationRunResult{Kind: RotationRunReject, Reason: reason}
}
