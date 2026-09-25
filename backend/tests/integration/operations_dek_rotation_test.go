//go:build integration

package integration_test

import (
	"context"
	"errors"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

var errInjectedKMSUnavailable = errors.New("injected KMS unavailable")

func TestScopedDEKRotationRunnerPersistsResumeAndOwnerIsolation(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountA, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	accountB, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	vaultA := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	seedCryptoVault(t, ctx, pool, string(accountA), vaultA)
	versionOne, _ := cryptocontent.ParseDEKVersion(1)
	versionTwo, _ := cryptocontent.ParseDEKVersion(2)
	keyStore, _ := postgresadapter.NewVaultDEKStore(pool)
	if err := keyStore.InsertInitial(ctx, cryptoMetadata(vaultA, versionOne, 1_000)); err != nil {
		t.Fatal(err)
	}
	operationID, _ := cryptocontent.ParseRotationOperationID("01991f20-61d2-7000-8000-000000000401")
	command := operations.DEKRotationCommand{
		AccountID: accountA, VaultID: vaultA, OperationID: operationID,
		RequestedAtMilli: 2_000, GeneratedAtMilli: 2_200, CompletedAtMilli: 2_300,
	}
	rotationStore, _ := postgresadapter.NewDEKRotationStore(pool)

	failingKeys := &failingOperationsRotationKeys{}
	failingRotation, _ := cryptocontent.NewRotationService(rotationStore, failingKeys)
	failingRunner, _ := operations.NewDEKRotationService(failingRotation)
	if result, err := failingRunner.Run(ctx, command); result != (operations.DEKRotationResult{}) ||
		!errors.Is(err, errInjectedKMSUnavailable) || failingKeys.calls != 1 {
		t.Fatalf("failed result = %#v, error = %v, calls = %d", result, err, failingKeys.calls)
	}
	loaded, err := rotationStore.Load(ctx, cryptocontent.RotationScope{AccountID: accountA, VaultID: vaultA})
	if err != nil || loaded.Kind != cryptocontent.RotationFound || loaded.Snapshot.Operation == nil {
		t.Fatalf("checkpoint after provider failure = %#v, %v", loaded, err)
	}
	if _, generating := loaded.Snapshot.Operation.State.(cryptocontent.RotationGenerating); !generating {
		t.Fatalf("state after provider failure = %#v", loaded.Snapshot.Operation.State)
	}

	keys := &integrationRotationKeys{metadata: cryptoMetadata(vaultA, versionTwo, 2_100)}
	rotation, _ := cryptocontent.NewRotationService(rotationStore, keys)
	runner, _ := operations.NewDEKRotationService(rotation)
	completed, err := runner.Run(ctx, command)
	if err != nil || completed.Kind != operations.DEKRotationCompleted ||
		completed.OperationID != operationID || keys.calls != 1 || keys.generated == nil || !keys.generated.Destroyed() {
		t.Fatalf("completed = %#v, error = %v, calls = %d, destroyed = %t",
			completed, err, keys.calls, keys.generated != nil && keys.generated.Destroyed())
	}
	replayed, err := runner.Run(ctx, command)
	if err != nil || replayed.Kind != operations.DEKRotationReplayed || keys.calls != 1 {
		t.Fatalf("replayed = %#v, error = %v, calls = %d", replayed, err, keys.calls)
	}

	wrongOwner := command
	wrongOwner.AccountID = accountB
	refused, err := runner.Run(ctx, wrongOwner)
	if err != nil || refused.Kind != operations.DEKRotationRefused ||
		refused.Reason != cryptocontent.RotationRunNotFound || keys.calls != 1 {
		t.Fatalf("cross-owner = %#v, error = %v, calls = %d", refused, err, keys.calls)
	}
	keyring, err := keyStore.FindKeyring(ctx, vaultA)
	if err != nil || keyring == nil || keyring.WriteVersion != versionTwo || len(keyring.Versions) != 2 {
		t.Fatalf("keyring = %#v, error = %v", keyring, err)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

type failingOperationsRotationKeys struct{ calls int }

func (keys *failingOperationsRotationKeys) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	keys.calls++
	return cryptocontent.VaultDEKMetadata{}, nil, errInjectedKMSUnavailable
}

func (*failingOperationsRotationKeys) UnwrapDataKey(
	context.Context,
	cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	return nil, errors.New("unexpected unwrap")
}
