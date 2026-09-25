package accountdeletion

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestPrivateObjectPurgeEffectMapsResults(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		port privateObjectPurgePortStub
		want StepEffectResult
	}{
		{
			name: "confirmed",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:    encryptedobject.VaultPrivateObjectPurgeConfirmed,
				Outcome: encryptedobject.VaultPrivateObjectPurgeDeleted,
			}},
			want: StepEffectResult{Kind: EffectSucceeded},
		},
		{
			name: "objects remaining",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeObjectsRemaining,
			}},
			want: retryableEffect("private-object-delete-incomplete"),
		},
		{
			name: "storage unavailable",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeStorageUnavailable,
			}},
			want: retryableEffect("private-object-storage-unavailable"),
		},
		{
			name: "outbox unavailable",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeOutboxUnavailable,
			}},
			want: retryableEffect("private-object-outbox-unavailable"),
		},
		{
			name: "confirmation unavailable",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeDeleteConfirmationUnavailable,
			}},
			want: retryableEffect("private-object-confirmation-unavailable"),
		},
		{
			name: "owner mismatch",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeTerminalFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeOwnerMismatch,
			}},
			want: terminalEffect("private-object-owner-mismatch"),
		},
		{
			name: "integrity failure",
			port: privateObjectPurgePortStub{result: encryptedobject.VaultPrivateObjectPurgeResult{
				Kind:   encryptedobject.VaultPrivateObjectPurgeTerminalFailure,
				Reason: encryptedobject.VaultPrivateObjectPurgeIntegrityFailure,
			}},
			want: terminalEffect("private-object-command-rejected"),
		},
		{
			name: "dependency error",
			port: privateObjectPurgePortStub{err: errors.New("unavailable")},
			want: retryableEffect("private-object-outbox-unavailable"),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			effect, err := NewPrivateObjectPurgeEffect(&test.port)
			if err != nil {
				t.Fatalf("NewPrivateObjectPurgeEffect() error = %v", err)
			}
			input := privateObjectEffectInput(t)
			got, err := effect.DeletePrivateObjects(context.Background(), input)
			if err != nil || got != test.want {
				t.Fatalf("DeletePrivateObjects() = %#v, %v; want %#v", got, err, test.want)
			}
			if test.port.command.PreviousReceiptAt != input.RequestedAt ||
				test.port.command.AttemptedAt != input.ExecutedAt ||
				string(test.port.command.OperationID) != string(input.OperationID) ||
				test.port.command.Scope.AccountID != input.Scope.AccountID ||
				test.port.command.Scope.VaultID != input.Scope.VaultID {
				t.Fatalf("command = %#v, input = %#v", test.port.command, input)
			}
		})
	}
}

func TestPrivateObjectPurgeEffectRejectsWrongStepWithoutIO(t *testing.T) {
	t.Parallel()
	port := &privateObjectPurgePortStub{}
	effect, _ := NewPrivateObjectPurgeEffect(port)
	input := privateObjectEffectInput(t)
	input.Step = StepDeleteVaultData
	result, err := effect.DeletePrivateObjects(context.Background(), input)
	if err != nil || result != terminalEffect("private-object-command-rejected") || port.calls != 0 {
		t.Fatalf("DeletePrivateObjects() = %#v, %v; calls = %d", result, err, port.calls)
	}
}

func privateObjectEffectInput(t *testing.T) StepEffectInput {
	t.Helper()
	input := validBillingEffectInput(t)
	input.Step = StepDeletePrivateObject
	input.ExecutedAt = input.RequestedAt + 100
	return input
}

type privateObjectPurgePortStub struct {
	result  encryptedobject.VaultPrivateObjectPurgeResult
	err     error
	command encryptedobject.VaultPrivateObjectPurgeCommand
	calls   int
}

func (port *privateObjectPurgePortStub) PurgeVaultPrivateObjects(
	_ context.Context,
	command encryptedobject.VaultPrivateObjectPurgeCommand,
) (encryptedobject.VaultPrivateObjectPurgeResult, error) {
	port.calls++
	port.command = command
	return port.result, port.err
}
