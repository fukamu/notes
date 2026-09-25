//go:build integration

package integration_test

import (
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestScopedDEKReencryptionRunnerPersistsFailureResumeReplayAndOwnerIsolation(t *testing.T) {
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

	repository, _ := postgresadapter.NewEncryptedObjectStore(pool, vaultA)
	objects, _ := objectstorage.NewMemory(nil)
	objectKeys := &integrationObjectKeys{values: []encryptedobject.ObjectKey{
		integrationObjectKey(t, 'A'), integrationObjectKey(t, 'B'),
	}}
	oldKeyring, encryption := integrationObjectEncryption(t, vaultA)
	writes, err := encryptedobject.NewService(vaultA, repository, objects, objectKeys, encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	if stored, err := writes.Write(ctx, integrationFirstObjectWrite(t, oldKeyring)); err != nil ||
		stored.Kind != encryptedobject.WriteStored {
		t.Fatalf("old object = %#v, error = %v", stored, err)
	}

	rotationStore, _ := postgresadapter.NewDEKRotationStore(pool)
	rotationKeys := &integrationRotationKeys{metadata: cryptoMetadata(vaultA, versionTwo, 2_100)}
	rotation, _ := cryptocontent.NewRotationService(rotationStore, rotationKeys)
	rotationRunner, _ := operations.NewDEKRotationService(rotation)
	rotationID := integrationRotationID(t, "01991f20-61d2-7000-8000-000000000401")
	rotationResult, err := rotationRunner.Run(ctx, operations.DEKRotationCommand{
		AccountID: accountA, VaultID: vaultA, OperationID: rotationID,
		RequestedAtMilli: 2_000, GeneratedAtMilli: 2_100, CompletedAtMilli: 2_200,
	})
	if err != nil || rotationResult.Kind != operations.DEKRotationCompleted {
		t.Fatalf("rotation = %#v, error = %v", rotationResult, err)
	}

	loader, _ := postgresadapter.NewDEKReencryptionScopeStore(pool)
	batches, _ := encryptedobject.NewReencryptionService(vaultA, repository, objects, objectKeys, encryption)
	runner, _ := operations.NewDEKReencryptionService(loader, batches)
	command := operations.DEKReencryptionCommand{
		AccountID: accountA, VaultID: vaultA, TargetVersion: versionTwo,
		Limit: 1, PerformedAtMilli: 3_000,
	}
	objects.FailNext(objectstorage.OperationGet)
	if result, err := runner.Run(ctx, command); result != (operations.DEKReencryptionResult{}) ||
		!errors.Is(err, objectstorage.ErrMemoryOperation) {
		t.Fatalf("storage failure result = %#v, error = %v", result, err)
	}
	var jobState string
	var jobRevision int64
	if err := pool.QueryRow(
		ctx,
		`SELECT state, revision FROM vault_reencryption_jobs WHERE vault_id = $1`,
		string(vaultA),
	).Scan(&jobState, &jobRevision); err != nil || jobState != "running" || jobRevision != 1 {
		t.Fatalf("failure checkpoint state=%q revision=%d error=%v", jobState, jobRevision, err)
	}

	completed, err := runner.Run(ctx, command)
	if err != nil || completed.Kind != operations.DEKReencryptionCompleted || completed.Processed != 1 ||
		completed.TargetVersion != versionTwo {
		t.Fatalf("completed = %#v, error = %v", completed, err)
	}
	callsAtCompletion := objects.Calls()
	encryptAtCompletion, decryptAtCompletion, keysAtCompletion := encryption.encrypt, encryption.decrypt, objectKeys.calls
	replayed, err := runner.Run(ctx, command)
	if err != nil || replayed.Kind != operations.DEKReencryptionCompleted || replayed.Processed != 0 {
		t.Fatalf("replayed = %#v, error = %v", replayed, err)
	}
	if objects.Calls() != callsAtCompletion || encryption.encrypt != encryptAtCompletion ||
		encryption.decrypt != decryptAtCompletion || objectKeys.calls != keysAtCompletion {
		t.Fatal("completed replay repeated storage, encryption, or key generation")
	}

	wrongOwner := command
	wrongOwner.AccountID = accountB
	refused, err := runner.Run(ctx, wrongOwner)
	if err != nil || refused.Kind != operations.DEKReencryptionRefused ||
		refused.Reason != encryptedobject.ReencryptionOwnerMissing {
		t.Fatalf("cross-owner = %#v, error = %v", refused, err)
	}
	if objects.Calls() != callsAtCompletion || encryption.encrypt != encryptAtCompletion ||
		encryption.decrypt != decryptAtCompletion || objectKeys.calls != keysAtCompletion {
		t.Fatal("cross-owner refusal reached an external effect")
	}
	var oldObjects, targetObjects, outbox int
	if err := pool.QueryRow(
		ctx,
		`SELECT
		   COUNT(*) FILTER (WHERE dek_version = 1),
		   COUNT(*) FILTER (WHERE dek_version = 2)
		 FROM vault_encrypted_objects WHERE vault_id = $1`,
		string(vaultA),
	).Scan(&oldObjects, &targetObjects); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(
		ctx,
		`SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $1`,
		string(vaultA),
	).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if oldObjects != 0 || targetObjects != 1 || outbox != 1 {
		t.Fatalf("inventory old=%d target=%d outbox=%d", oldObjects, targetObjects, outbox)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}
