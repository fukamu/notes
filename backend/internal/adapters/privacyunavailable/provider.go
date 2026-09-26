package privacyunavailable

import (
	"context"

	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

// Provider is the explicit fail-closed boundary used when the local fixture
// has no reviewed identity verification, fulfillment, or account-deletion
// handoff. Returning typed unavailable results prevents a durable journal from
// being mistaken for a functioning processor.
type Provider struct{}

func New() *Provider { return &Provider{} }

func (*Provider) Verify(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
	privacyrequest.RequestKind,
	int64,
) (privacyrequest.VerificationResult, error) {
	return privacyrequest.VerificationResult{Kind: privacyrequest.VerificationResultUnavailable}, nil
}

func (*Provider) Execute(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
	privacyrequest.RequestKind,
) (privacyrequest.ExecutionResult, error) {
	failureCode, _ := privacyrequest.ParseFailureCode("executor-unavailable")
	return privacyrequest.ExecutionResult{
		Kind:        privacyrequest.ExecutionFailed,
		FailureCode: failureCode,
		Retryable:   true,
	}, nil
}

func (*Provider) StartExistingAccountDeletion(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
) (privacyrequest.DeletionHandoffResult, error) {
	failureCode, _ := privacyrequest.ParseFailureCode("account-deletion-unavailable")
	return privacyrequest.DeletionHandoffResult{
		Kind:        privacyrequest.DeletionHandoffFailed,
		FailureCode: failureCode,
		Retryable:   true,
	}, nil
}
