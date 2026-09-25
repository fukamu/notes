package accountdeletion

import (
	"context"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

type PrivateObjectPurgeEffect struct {
	purge encryptedobject.VaultPrivateObjectPurgePort
}

var _ PrivateObjectPurgePort = (*PrivateObjectPurgeEffect)(nil)

func NewPrivateObjectPurgeEffect(
	purge encryptedobject.VaultPrivateObjectPurgePort,
) (*PrivateObjectPurgeEffect, error) {
	if purge == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &PrivateObjectPurgeEffect{purge: purge}, nil
}

func (effect *PrivateObjectPurgeEffect) DeletePrivateObjects(
	ctx context.Context,
	input StepEffectInput,
) (StepEffectResult, error) {
	if effect == nil || effect.purge == nil || !ValidStepEffectInput(input, StepDeletePrivateObject) {
		return terminalEffect("private-object-command-rejected"), nil
	}
	operationID, err := encryptedobject.ParsePurgeOperationID(string(input.OperationID))
	if err != nil {
		return terminalEffect("private-object-command-rejected"), nil
	}
	result, err := effect.purge.PurgeVaultPrivateObjects(ctx, encryptedobject.VaultPrivateObjectPurgeCommand{
		Scope: encryptedobject.VaultPrivateObjectPurgeScope{
			AccountID: input.Scope.AccountID,
			VaultID:   input.Scope.VaultID,
		},
		OperationID:       operationID,
		PreviousReceiptAt: input.RequestedAt,
		AttemptedAt:       input.ExecutedAt,
	})
	if err != nil {
		return retryableEffect("private-object-outbox-unavailable"), nil
	}
	switch result.Kind {
	case encryptedobject.VaultPrivateObjectPurgeConfirmed:
		return StepEffectResult{Kind: EffectSucceeded}, nil
	case encryptedobject.VaultPrivateObjectPurgeRetryableFailure:
		switch result.Reason {
		case encryptedobject.VaultPrivateObjectPurgeObjectsRemaining:
			return retryableEffect("private-object-delete-incomplete"), nil
		case encryptedobject.VaultPrivateObjectPurgeStorageUnavailable:
			return retryableEffect("private-object-storage-unavailable"), nil
		case encryptedobject.VaultPrivateObjectPurgeOutboxUnavailable:
			return retryableEffect("private-object-outbox-unavailable"), nil
		default:
			return retryableEffect("private-object-confirmation-unavailable"), nil
		}
	case encryptedobject.VaultPrivateObjectPurgeTerminalFailure:
		if result.Reason == encryptedobject.VaultPrivateObjectPurgeOwnerMismatch {
			return terminalEffect("private-object-owner-mismatch"), nil
		}
		return terminalEffect("private-object-command-rejected"), nil
	default:
		return retryableEffect("private-object-confirmation-unavailable"), nil
	}
}
