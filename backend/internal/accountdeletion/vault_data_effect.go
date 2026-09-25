package accountdeletion

import (
	"context"

	"github.com/fukamu/notes/backend/internal/vaultdata"
)

type VaultDataPurgeEffect struct {
	purge vaultdata.PurgePort
}

var _ VaultDataPurgePort = (*VaultDataPurgeEffect)(nil)

func NewVaultDataPurgeEffect(purge vaultdata.PurgePort) (*VaultDataPurgeEffect, error) {
	if purge == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &VaultDataPurgeEffect{purge: purge}, nil
}

func (effect *VaultDataPurgeEffect) DeleteVaultData(
	ctx context.Context,
	input StepEffectInput,
) (StepEffectResult, error) {
	if effect == nil || effect.purge == nil || !ValidStepEffectInput(input, StepDeleteVaultData) {
		return terminalEffect("vault-data-terminal"), nil
	}
	operationID, err := vaultdata.ParseOperationID(string(input.OperationID))
	if err != nil {
		return terminalEffect("vault-data-terminal"), nil
	}
	result, err := effect.purge.Purge(ctx, vaultdata.PurgeCommand{
		Scope: vaultdata.Scope{
			AccountID: input.Scope.AccountID,
			VaultID:   input.Scope.VaultID,
		},
		OperationID: operationID,
		RequestedAt: input.RequestedAt,
	})
	if err != nil {
		return retryableEffect("vault-live-data-unavailable"), nil
	}
	switch result.Kind {
	case vaultdata.PurgeConfirmed:
		return StepEffectResult{Kind: EffectSucceeded}, nil
	case vaultdata.PurgeRetryableFailure:
		if result.Reason == vaultdata.FailureRepositoryUnavailable {
			return retryableEffect("vault-live-data-unavailable"), nil
		}
		return retryableEffect("vault-live-data-incomplete"), nil
	case vaultdata.PurgeTerminalFailure:
		if result.Reason == vaultdata.FailureOwnerMismatch {
			return terminalEffect("vault-owner-mismatch"), nil
		}
		if result.Reason == vaultdata.FailureIntegrity {
			return terminalEffect("vault-data-integrity"), nil
		}
		return terminalEffect("vault-data-terminal"), nil
	default:
		return retryableEffect("vault-live-data-incomplete"), nil
	}
}
