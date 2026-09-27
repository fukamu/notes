package privacyunavailable

import (
	"context"
	"testing"

	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

func TestProviderKeepsEveryUnreviewedPrivacyCapabilityUnavailable(t *testing.T) {
	provider := New()
	verification, err := provider.Verify(context.Background(), privacyrequest.Scope{}, "", "", 0)
	if err != nil || verification.Kind != privacyrequest.VerificationResultUnavailable {
		t.Fatalf("Verify() = %#v, %v", verification, err)
	}
	execution, err := provider.Execute(context.Background(), privacyrequest.Scope{}, "", "")
	if err != nil || execution.Kind != privacyrequest.ExecutionFailed ||
		execution.FailureCode != "executor-unavailable" || !execution.Retryable {
		t.Fatalf("Execute() = %#v, %v", execution, err)
	}
	deletion, err := provider.StartExistingAccountDeletion(context.Background(), privacyrequest.Scope{}, "")
	if err != nil || deletion.Kind != privacyrequest.DeletionHandoffFailed ||
		deletion.FailureCode != "account-deletion-unavailable" || !deletion.Retryable {
		t.Fatalf("StartExistingAccountDeletion() = %#v, %v", deletion, err)
	}
}
