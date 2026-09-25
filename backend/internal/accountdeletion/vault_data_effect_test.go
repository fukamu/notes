package accountdeletion

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/vaultdata"
)

func TestVaultDataPurgeEffectMapsResults(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		port purgePortStub
		want StepEffectResult
	}{
		{
			name: "confirmed",
			port: purgePortStub{result: vaultdata.PurgeResult{Kind: vaultdata.PurgeConfirmed, Outcome: vaultdata.OutcomePurged}},
			want: StepEffectResult{Kind: EffectSucceeded},
		},
		{
			name: "unavailable",
			port: purgePortStub{result: vaultdata.PurgeResult{
				Kind: vaultdata.PurgeRetryableFailure, Reason: vaultdata.FailureRepositoryUnavailable,
			}},
			want: retryableEffect("vault-live-data-unavailable"),
		},
		{
			name: "incomplete",
			port: purgePortStub{result: vaultdata.PurgeResult{
				Kind: vaultdata.PurgeRetryableFailure, Reason: vaultdata.FailureIncomplete,
			}},
			want: retryableEffect("vault-live-data-incomplete"),
		},
		{
			name: "owner mismatch",
			port: purgePortStub{result: vaultdata.PurgeResult{
				Kind: vaultdata.PurgeTerminalFailure, Reason: vaultdata.FailureOwnerMismatch,
			}},
			want: terminalEffect("vault-owner-mismatch"),
		},
		{
			name: "integrity failure",
			port: purgePortStub{result: vaultdata.PurgeResult{
				Kind: vaultdata.PurgeTerminalFailure, Reason: vaultdata.FailureIntegrity,
			}},
			want: terminalEffect("vault-data-integrity"),
		},
		{
			name: "thrown dependency error",
			port: purgePortStub{err: errors.New("unavailable")},
			want: retryableEffect("vault-live-data-unavailable"),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			effect, err := NewVaultDataPurgeEffect(&test.port)
			if err != nil {
				t.Fatalf("NewVaultDataPurgeEffect() error = %v", err)
			}
			input := vaultDataEffectInput(t)
			got, err := effect.DeleteVaultData(context.Background(), input)
			if err != nil || got != test.want {
				t.Fatalf("DeleteVaultData() = %#v, %v; want %#v", got, err, test.want)
			}
			if test.port.command.RequestedAt != input.RequestedAt ||
				string(test.port.command.OperationID) != string(input.OperationID) ||
				test.port.command.Scope.AccountID != input.Scope.AccountID ||
				test.port.command.Scope.VaultID != input.Scope.VaultID {
				t.Fatalf("command = %#v, input = %#v", test.port.command, input)
			}
		})
	}
}

func TestVaultDataPurgeEffectRejectsWrongStepWithoutIO(t *testing.T) {
	t.Parallel()
	port := &purgePortStub{}
	effect, _ := NewVaultDataPurgeEffect(port)
	input := vaultDataEffectInput(t)
	input.Step = StepRevokeSessions
	result, err := effect.DeleteVaultData(context.Background(), input)
	if err != nil || result != terminalEffect("vault-data-terminal") || port.calls != 0 {
		t.Fatalf("DeleteVaultData() = %#v, %v; calls = %d", result, err, port.calls)
	}
}

func vaultDataEffectInput(t *testing.T) StepEffectInput {
	t.Helper()
	input := validBillingEffectInput(t)
	input.Step = StepDeleteVaultData
	return input
}

type purgePortStub struct {
	result  vaultdata.PurgeResult
	err     error
	command vaultdata.PurgeCommand
	calls   int
}

func (port *purgePortStub) Purge(
	_ context.Context,
	command vaultdata.PurgeCommand,
) (vaultdata.PurgeResult, error) {
	port.calls++
	port.command = command
	return port.result, port.err
}
