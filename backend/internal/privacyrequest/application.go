package privacyrequest

import (
	"context"
	"errors"
)

type VerificationResultKind string

const (
	VerificationResultApproved    VerificationResultKind = "approved"
	VerificationResultRejected    VerificationResultKind = "rejected"
	VerificationResultUnavailable VerificationResultKind = "unavailable"
)

type VerificationResult struct {
	Kind      VerificationResultKind
	ReceiptID VerificationReceiptID
	Reason    RejectionReason
}

type VerificationPort interface {
	Verify(context.Context, Scope, RequestID, RequestKind, int64) (VerificationResult, error)
}

type ExecutionResultKind string

const (
	ExecutionFulfilled ExecutionResultKind = "fulfilled"
	ExecutionFailed    ExecutionResultKind = "failed"
)

type ExecutionResult struct {
	Kind        ExecutionResultKind
	FailureCode FailureCode
	Retryable   bool
}

type ExecutionPort interface {
	Execute(context.Context, Scope, RequestID, RequestKind) (ExecutionResult, error)
}

type DeletionHandoffResultKind string

const (
	DeletionHandoffStarted DeletionHandoffResultKind = "started"
	DeletionHandoffFailed  DeletionHandoffResultKind = "failed"
)

type DeletionHandoffResult struct {
	Kind        DeletionHandoffResultKind
	FailureCode FailureCode
	Retryable   bool
}

type DeletionHandoffPort interface {
	StartExistingAccountDeletion(context.Context, Scope, RequestID) (DeletionHandoffResult, error)
}

type ApplicationResultKind string
type ApplicationOutcome string
type ApplicationReason string

const (
	ApplicationAccepted ApplicationResultKind = "accepted"
	ApplicationRejected ApplicationResultKind = "rejected"

	ApplicationRecorded ApplicationOutcome = "recorded"
	ApplicationReplayed ApplicationOutcome = "replayed"
	ApplicationStatus   ApplicationOutcome = "status"
	ApplicationUpdated  ApplicationOutcome = "updated"

	ApplicationIdentifierConflict ApplicationReason = "identifier-conflict"
	ApplicationInvalidInput       ApplicationReason = "invalid-input"
	ApplicationInvalidState       ApplicationReason = "invalid-state"
	ApplicationNotFound           ApplicationReason = "not-found"
	ApplicationUnavailable        ApplicationReason = "unavailable"
)

type ApplicationResult struct {
	Kind    ApplicationResultKind
	Outcome ApplicationOutcome
	Reason  ApplicationReason
	Request *PublicStatus
}

type Service struct {
	repository      Repository
	verification    VerificationPort
	execution       ExecutionPort
	accountDeletion DeletionHandoffPort
}

func NewService(repository Repository, verification VerificationPort, execution ExecutionPort, accountDeletion DeletionHandoffPort) (*Service, error) {
	if repository == nil || verification == nil || execution == nil || accountDeletion == nil {
		return nil, errors.New("complete privacy request dependencies are required")
	}
	return &Service{
		repository: repository, verification: verification,
		execution: execution, accountDeletion: accountDeletion,
	}, nil
}

func (service *Service) Submit(ctx context.Context, scope Scope, command SubmitCommand, requestID RequestID, requestedAt int64) (ApplicationResult, error) {
	if service == nil || service.repository == nil {
		return ApplicationResult{Kind: ApplicationRejected, Reason: ApplicationUnavailable}, nil
	}
	plan := PlanStart(scope, requestID, command.SubmissionID, command.RequestKind, requestedAt)
	if plan.Kind != PlanAccepted {
		return rejectedResult(ApplicationInvalidInput), nil
	}
	created, err := service.repository.Create(ctx, plan.Record)
	if err != nil {
		return ApplicationResult{}, err
	}
	switch created.Kind {
	case CreateCreated:
		return acceptedResult(ApplicationRecorded, created.Record)
	case CreateExisting:
		if created.Record == nil || created.Record.RequestKind != command.RequestKind {
			return rejectedResult(ApplicationIdentifierConflict), nil
		}
		return acceptedResult(ApplicationReplayed, created.Record)
	case CreateConflict:
		return rejectedResult(ApplicationIdentifierConflict), nil
	case CreateRejected:
		return rejectedResult(ApplicationInvalidInput), nil
	default:
		return rejectedResult(ApplicationUnavailable), nil
	}
}

func (service *Service) Status(ctx context.Context, scope Scope, requestID RequestID) (ApplicationResult, error) {
	record, err := service.repository.FindByID(ctx, scope, requestID)
	if err != nil {
		return ApplicationResult{}, err
	}
	if record == nil {
		return rejectedResult(ApplicationNotFound), nil
	}
	return acceptedResult(ApplicationStatus, record)
}

func (service *Service) Verify(ctx context.Context, scope Scope, requestID RequestID, checkedAt int64) (ApplicationResult, error) {
	record, err := service.repository.FindByID(ctx, scope, requestID)
	if err != nil {
		return ApplicationResult{}, err
	}
	if record == nil {
		return rejectedResult(ApplicationNotFound), nil
	}
	if _, pending := record.State.(VerificationPending); !pending {
		return acceptedResult(ApplicationStatus, record)
	}
	verification, err := service.verification.Verify(ctx, scope, requestID, record.RequestKind, checkedAt)
	if err != nil {
		return ApplicationResult{}, err
	}
	if verification.Kind == VerificationResultUnavailable {
		return rejectedResult(ApplicationUnavailable), nil
	}
	decision := VerificationDecision{DecidedAt: checkedAt}
	switch verification.Kind {
	case VerificationResultApproved:
		decision.Kind = VerificationApproved
		decision.ReceiptID = verification.ReceiptID
	case VerificationResultRejected:
		decision.Kind = VerificationRejected
		decision.Reason = verification.Reason
	default:
		return rejectedResult(ApplicationUnavailable), nil
	}
	plan := PlanVerification(*record, decision)
	if plan.Kind != PlanAccepted {
		return rejectedResult(ApplicationInvalidState), nil
	}
	return service.commit(ctx, scope, plan.Transition)
}

func (service *Service) Process(ctx context.Context, scope Scope, requestID RequestID, startedAt int64, finishedAt int64) (ApplicationResult, error) {
	record, err := service.repository.FindByID(ctx, scope, requestID)
	if err != nil {
		return ApplicationResult{}, err
	}
	if record == nil {
		return rejectedResult(ApplicationNotFound), nil
	}
	if _, ready := record.State.(Ready); !ready {
		return acceptedResult(ApplicationStatus, record)
	}
	claim := PlanProcessingStart(*record, startedAt)
	if claim.Kind != PlanAccepted {
		return rejectedResult(ApplicationInvalidState), nil
	}
	claimed, err := service.repository.Commit(ctx, scope, claim.Transition)
	if err != nil {
		return ApplicationResult{}, err
	}
	if claimed.Kind != CommitApplied {
		return resultFromCommit(claimed)
	}
	if claimed.Record == nil {
		return rejectedResult(ApplicationUnavailable), nil
	}
	execution := service.execute(ctx, scope, *claimed.Record)
	var completion Plan
	if execution.Kind == executionCompleted {
		completion = PlanCompletion(*claimed.Record, finishedAt, execution.Outcome)
	} else {
		completion = PlanFailure(*claimed.Record, finishedAt, execution.FailureCode, execution.Retryable)
	}
	if completion.Kind != PlanAccepted {
		return rejectedResult(ApplicationInvalidState), nil
	}
	return service.commit(ctx, scope, completion.Transition)
}

type executionDecisionKind string

const (
	executionCompleted executionDecisionKind = "completed"
	executionFailed    executionDecisionKind = "failed"
)

type executionDecision struct {
	Kind        executionDecisionKind
	Outcome     Outcome
	FailureCode FailureCode
	Retryable   bool
}

func (service *Service) execute(ctx context.Context, scope Scope, record Record) executionDecision {
	unavailable, _ := ParseFailureCode("executor-unavailable")
	if record.RequestKind == KindDeletion {
		result, err := service.accountDeletion.StartExistingAccountDeletion(ctx, scope, record.RequestID)
		if err != nil {
			return executionDecision{Kind: executionFailed, FailureCode: unavailable, Retryable: true}
		}
		if result.Kind == DeletionHandoffStarted {
			return executionDecision{Kind: executionCompleted, Outcome: OutcomeAccountDeletionStarted}
		}
		if result.Kind == DeletionHandoffFailed {
			return executionDecision{Kind: executionFailed, FailureCode: result.FailureCode, Retryable: result.Retryable}
		}
		return executionDecision{Kind: executionFailed, FailureCode: unavailable, Retryable: true}
	}
	result, err := service.execution.Execute(ctx, scope, record.RequestID, record.RequestKind)
	if err != nil {
		return executionDecision{Kind: executionFailed, FailureCode: unavailable, Retryable: true}
	}
	if result.Kind == ExecutionFulfilled {
		return executionDecision{Kind: executionCompleted, Outcome: OutcomeFulfilled}
	}
	if result.Kind == ExecutionFailed {
		return executionDecision{Kind: executionFailed, FailureCode: result.FailureCode, Retryable: result.Retryable}
	}
	return executionDecision{Kind: executionFailed, FailureCode: unavailable, Retryable: true}
}

func (service *Service) commit(ctx context.Context, scope Scope, transition Transition) (ApplicationResult, error) {
	result, err := service.repository.Commit(ctx, scope, transition)
	if err != nil {
		return ApplicationResult{}, err
	}
	return resultFromCommit(result)
}

func resultFromCommit(result CommitResult) (ApplicationResult, error) {
	switch result.Kind {
	case CommitApplied, CommitReplayed:
		return acceptedResult(ApplicationUpdated, result.Record)
	case CommitConflict:
		if result.Current == nil {
			return rejectedResult(ApplicationNotFound), nil
		}
		return acceptedResult(ApplicationStatus, result.Current)
	case CommitRejected:
		return rejectedResult(ApplicationInvalidState), nil
	default:
		return rejectedResult(ApplicationUnavailable), nil
	}
}

func acceptedResult(outcome ApplicationOutcome, record *Record) (ApplicationResult, error) {
	if record == nil {
		return rejectedResult(ApplicationUnavailable), nil
	}
	status, err := PublicStatusFromRecord(*record)
	if err != nil {
		return ApplicationResult{}, err
	}
	return ApplicationResult{Kind: ApplicationAccepted, Outcome: outcome, Request: &status}, nil
}

func rejectedResult(reason ApplicationReason) ApplicationResult {
	return ApplicationResult{Kind: ApplicationRejected, Reason: reason}
}
