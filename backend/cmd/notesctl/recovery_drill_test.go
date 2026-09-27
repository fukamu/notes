package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	contentcryptoadapter "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestRecoveryDrillCLIParsesRunsAndRedacts(t *testing.T) {
	backupRoot := privateRecoveryDirectory(t)
	keyRoot := privateRecoveryDirectory(t)
	arguments := recoveryDrillCLIArguments("test", backupRoot, keyRoot)
	parsed, requested, err := parseRecoveryDrillArguments(arguments)
	if err != nil || !requested {
		t.Fatalf("parse=%#v requested=%t err=%v", parsed, requested, err)
	}
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runRecoveryDrill(
		context.Background(), parsed, &stdout, &stderr,
		func(key string) (string, bool) {
			if key == "NOTES_ENVIRONMENT" {
				return "test", true
			}
			return "", false
		},
		func(_ context.Context, actualBackup, actualKeys string, command operations.RecoveryDrillCommand) (operations.RecoveryDrillResult, error) {
			called = true
			if actualBackup != backupRoot || actualKeys != keyRoot || command != parsed.command {
				t.Fatal("validated recovery inputs changed")
			}
			return operations.RecoveryDrillResult{
				Kind: operations.RecoveryDrillVerified, SourceVersion: 1, TargetVersion: 2,
				ObjectCount: 4, VerifiedVersions: 2,
			}, nil
		},
	)
	if code != 0 || !called || stderr.Len() != 0 {
		t.Fatalf("code=%d called=%t stdout=%q stderr=%q", code, called, stdout.String(), stderr.String())
	}
	var output map[string]any
	if json.Unmarshal(stdout.Bytes(), &output) != nil || output["command"] != "recovery-drill" ||
		output["outcome"] != "verified" || output["objectCount"] != float64(4) ||
		output["verifiedVersions"] != float64(2) {
		t.Fatalf("output=%q", stdout.String())
	}
	for _, secret := range []string{string(parsed.command.AccountID), string(parsed.command.VaultID), backupRoot, keyRoot} {
		if strings.Contains(stdout.String(), secret) {
			t.Fatalf("output disclosed %q", secret)
		}
	}
}

func TestRecoveryDrillCommandDispatchesOnlyRecoveryDependency(t *testing.T) {
	backupRoot := privateRecoveryDirectory(t)
	keyRoot := privateRecoveryDirectory(t)
	arguments := recoveryDrillCLIArguments("test", backupRoot, keyRoot)
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithRecoveryDependency(
		context.Background(), arguments, &stdout, &stderr,
		func(key string) (string, bool) {
			if key == "NOTES_ENVIRONMENT" {
				return "test", true
			}
			return "", false
		},
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t), dekRotationMustNotRun(t), dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t), deleteOutboxMustNotRun(t),
		func(context.Context, string, string, operations.RecoveryDrillCommand) (operations.RecoveryDrillResult, error) {
			called = true
			return operations.RecoveryDrillResult{
				Kind: operations.RecoveryDrillVerified, SourceVersion: 1, TargetVersion: 2,
			}, nil
		},
	)
	if code != 0 || !called || stderr.Len() != 0 {
		t.Fatalf("code=%d called=%t stdout=%q stderr=%q", code, called, stdout.String(), stderr.String())
	}
}

func TestRecoveryDrillCLIRejectsInvalidAndSensitiveFailures(t *testing.T) {
	backupRoot := privateRecoveryDirectory(t)
	keyRoot := privateRecoveryDirectory(t)
	valid := recoveryDrillCLIArguments("test", backupRoot, keyRoot)
	tests := [][]string{
		recoveryDrillCLIArguments("production", backupRoot, keyRoot),
		removeRecoveryArgument(valid, "--confirm-local-backup-read"),
		removeRecoveryArgument(valid, "--confirm-local-fixture-key-read"),
		replaceRecoveryArgument(valid, "--backup-root", keyRoot),
		replaceRecoveryArgument(valid, "--key-root", "relative"),
		append(append([]string(nil), valid...), "--drilled-at-millis=4000"),
	}
	for _, arguments := range tests {
		if _, requested, err := parseRecoveryDrillArguments(arguments); !requested || err == nil {
			t.Fatalf("arguments=%q requested=%t err=%v", arguments, requested, err)
		}
	}

	parsed, _, _ := parseRecoveryDrillArguments(valid)
	for _, testCase := range []struct {
		name   string
		values map[string]string
		run    runRecoveryDrillFunction
		code   int
		want   string
	}{
		{name: "missing environment", values: map[string]string{}, run: recoveryDrillMustNotRun(t), code: 1, want: "recovery drill environment refused\n"},
		{name: "wrong environment", values: map[string]string{"NOTES_ENVIRONMENT": "local"}, run: recoveryDrillMustNotRun(t), code: 1, want: "recovery drill environment refused\n"},
		{
			name: "dependency failure", values: map[string]string{"NOTES_ENVIRONMENT": "test"}, code: 1,
			run: func(context.Context, string, string, operations.RecoveryDrillCommand) (operations.RecoveryDrillResult, error) {
				return operations.RecoveryDrillResult{}, errors.New("PRIVATE key path secret")
			},
			want: "recovery drill failed\n",
		},
		{
			name: "blocked", values: map[string]string{"NOTES_ENVIRONMENT": "test"}, code: 1,
			run: func(context.Context, string, string, operations.RecoveryDrillCommand) (operations.RecoveryDrillResult, error) {
				return operations.RecoveryDrillResult{Kind: operations.RecoveryDrillBlocked, Reason: encryptedobject.RecoveryAuthenticationFailed}, nil
			},
			want: "",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			code := runRecoveryDrill(
				context.Background(), parsed, &stdout, &stderr,
				func(key string) (string, bool) { value, ok := testCase.values[key]; return value, ok },
				testCase.run,
			)
			if code != testCase.code || stderr.String() != testCase.want ||
				strings.Contains(stderr.String(), "PRIVATE") || strings.Contains(stderr.String(), "secret") ||
				strings.Contains(stdout.String(), backupRoot) || strings.Contains(stdout.String(), keyRoot) {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunVaultRecoveryDrillAuthenticatesPrivateFixture(t *testing.T) {
	fixture := writeRecoveryDrillFixture(t)
	result, err := runVaultRecoveryDrill(
		context.Background(), fixture.backupRoot, fixture.keyRoot, fixture.command,
	)
	if err != nil || result.Kind != operations.RecoveryDrillVerified || result.ObjectCount != 2 ||
		result.SourceVersion != 1 || result.TargetVersion != 2 || result.VerifiedVersions != 2 {
		t.Fatalf("result=%#v err=%v", result, err)
	}

	encoded, err := os.ReadFile(fixture.firstObjectPath)
	if err != nil {
		t.Fatal(err)
	}
	encoded[len(encoded)-2] ^= 1
	if err := os.WriteFile(fixture.firstObjectPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err = runVaultRecoveryDrill(
		context.Background(), fixture.backupRoot, fixture.keyRoot, fixture.command,
	)
	if err != nil || result.Kind != operations.RecoveryDrillBlocked ||
		(result.Reason != encryptedobject.RecoveryInvalidCiphertext && result.Reason != encryptedobject.RecoveryAuthenticationFailed) {
		t.Fatalf("tampered result=%#v err=%v", result, err)
	}
}

type recoveryFixture struct {
	backupRoot      string
	keyRoot         string
	firstObjectPath string
	command         operations.RecoveryDrillCommand
}

func writeRecoveryDrillFixture(t *testing.T) recoveryFixture {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000001101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000001201")
	operationID, _ := cryptocontent.ParseRotationOperationID("01991f20-61d2-7000-8000-000000001901")
	backupID, _ := encryptedobject.ParseRecoveryBackupID("backup_cli_fixture")
	metadataOne := recoveryFixtureKeyMetadata(vaultID, 1, 500)
	metadataTwo := recoveryFixtureKeyMetadata(vaultID, 2, 2_000)
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, 2, []cryptocontent.VaultDEKMetadata{metadataOne, metadataTwo})
	if err != nil {
		t.Fatal(err)
	}
	rawKeys := map[cryptocontent.DEKVersion][]byte{1: bytes.Repeat([]byte{1}, 32), 2: bytes.Repeat([]byte{2}, 32)}
	encryption, err := cryptocontent.NewService(
		&recoveryFixtureKeys{keys: rawKeys}, &recoveryFixtureNonces{}, &recoveryFixtureReservations{}, contentcryptoadapter.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	objects := []struct {
		kind      cryptocontent.ObjectKind
		objectID  string
		writeID   string
		objectKey string
		revision  int64
		version   cryptocontent.DEKVersion
		plaintext []byte
	}{
		{cryptocontent.ObjectCard, "01991f20-61d2-7000-8000-000000000101", "01991f20-61d2-7000-8000-000000000201", "obj_v1_" + strings.Repeat("A", 43), 1, 1, []byte("fixture-one")},
		{cryptocontent.ObjectConflict, "01991f20-61d2-7000-8000-000000000102", "01991f20-61d2-7000-8000-000000000202", "obj_v1_" + strings.Repeat("B", 43), 2, 2, []byte("fixture-two")},
	}
	backupRoot := privateRecoveryDirectory(t)
	keyRoot := privateRecoveryDirectory(t)
	backupDataRoot := filepath.Join(backupRoot, string(backupID))
	if err := os.Mkdir(backupDataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	manifestObjects := make([]encryptedobject.Metadata, 0, len(objects))
	firstObjectPath := ""
	for _, object := range objects {
		revision, _ := cryptocontent.ParseObjectRevision(object.revision)
		writeKeyring, err := cryptocontent.NewVaultDEKKeyring(
			vaultID, object.version, []cryptocontent.VaultDEKMetadata{metadataOne, metadataTwo},
		)
		if err != nil {
			t.Fatal(err)
		}
		ciphertext, err := encryption.Encrypt(context.Background(), writeKeyring, cryptocontent.ObjectContext{
			VaultID: vaultID, Kind: object.kind, ObjectID: object.objectID, ObjectRevision: revision,
		}, object.plaintext)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(ciphertext)
		if err != nil {
			t.Fatal(err)
		}
		key, _ := encryptedobject.ParseObjectKey(object.objectKey)
		path := filepath.Join(backupDataRoot, string(key))
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		if firstObjectPath == "" {
			firstObjectPath = path
		}
		writeID, _ := encryptedobject.ParseWriteID(object.writeID)
		manifestObjects = append(manifestObjects, encryptedobject.Metadata{
			Object:         encryptedobject.ObjectRef{Kind: object.kind, ObjectID: object.objectID},
			ObjectRevision: revision, WriteID: writeID, ObjectKey: key,
			PlaintextBytes: int64(len(object.plaintext)), CiphertextBytes: int64(len(encoded)),
			CryptoVersion: cryptocontent.EnvelopeCryptoVersion, DEKVersion: object.version, CreatedAtMilli: 2_150,
		})
	}
	rotation := cryptocontent.RotationOperation{
		RotationScope: cryptocontent.RotationScope{AccountID: accountID, VaultID: vaultID},
		OperationID:   operationID, Revision: 3, SourceVersion: 1, TargetVersion: 2,
		State:          cryptocontent.RotationCompleted{Metadata: metadataTwo, CompletedAtMilli: 2_100},
		CreatedAtMilli: 1_500, UpdatedAtMilli: 2_100,
	}
	manifest := encryptedobject.RecoveryManifest{
		Format:        encryptedobject.VaultRecoveryFormat,
		RecoveryScope: encryptedobject.RecoveryScope{AccountID: accountID, VaultID: vaultID},
		BackupID:      backupID, CapturedAt: 2_200, DeleteAfter: 10_000,
		Keyring: keyring, Rotation: rotation,
		Reencryption: encryptedobject.RecoveryReencryptionCompleted{TargetVersion: 2}, Objects: manifestObjects,
	}
	manifestBytes, err := encryptedobject.EncodeRecoveryManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backupRoot, "manifest.json"), manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	writeRecoveryFixtureKey(t, keyRoot, metadataOne, rawKeys[1])
	writeRecoveryFixtureKey(t, keyRoot, metadataTwo, rawKeys[2])
	return recoveryFixture{
		backupRoot: backupRoot, keyRoot: keyRoot, firstObjectPath: firstObjectPath,
		command: operations.RecoveryDrillCommand{AccountID: accountID, VaultID: vaultID, DrilledAt: 3_000},
	}
}

func recoveryFixtureKeyMetadata(vaultID identity.VaultID, version cryptocontent.DEKVersion, createdAt int64) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: version,
		KEKReference:   "fixture-kek-version-" + string(rune('0'+version)),
		WrappedDEK:     cryptocontent.EncodeBase64URL([]byte("fixture-wrapped-key-" + string(rune('0'+version)))),
		CreatedAtMilli: createdAt,
	}
}

func writeRecoveryFixtureKey(t *testing.T, root string, metadata cryptocontent.VaultDEKMetadata, raw []byte) {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"format": recoverykey.FixtureKeyFormat, "vaultId": metadata.VaultID,
		"dekVersion": metadata.DEKVersion, "kekKeyReference": metadata.KEKReference,
		"wrappedDek": metadata.WrappedDEK, "rawDek": cryptocontent.EncodeBase64URL(raw),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dek-"+string(rune('0'+metadata.DEKVersion))+".json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

type recoveryFixtureKeys struct {
	keys map[cryptocontent.DEKVersion][]byte
}

func (keys *recoveryFixtureKeys) GenerateDataKey(context.Context, identity.VaultID, cryptocontent.DEKVersion) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.VaultDEKMetadata{}, nil, errors.New("unused")
}

func (keys *recoveryFixtureKeys) UnwrapDataKey(_ context.Context, metadata cryptocontent.VaultDEKMetadata) (*cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.NewDataEncryptionKey(keys.keys[metadata.DEKVersion])
}

type recoveryFixtureNonces struct{ next byte }

func (nonces *recoveryFixtureNonces) CreateNonce(context.Context) ([]byte, error) {
	nonces.next++
	return bytes.Repeat([]byte{nonces.next}, 12), nil
}

type recoveryFixtureReservations struct{}

func (*recoveryFixtureReservations) ReserveNonce(context.Context, identity.VaultID, cryptocontent.DEKVersion, string) (bool, error) {
	return true, nil
}

func privateRecoveryDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

func recoveryDrillCLIArguments(environment, backupRoot, keyRoot string) []string {
	return []string{
		"recovery", "drill", "--environment=" + environment,
		"--account-id=01991f20-61d2-7000-8000-000000001101",
		"--vault-id=01991f20-61d2-7000-8000-000000001201",
		"--drilled-at-millis=3000", "--backup-root=" + backupRoot, "--key-root=" + keyRoot,
		"--confirm-local-backup-read", "--confirm-local-fixture-key-read",
	}
}

func removeRecoveryArgument(arguments []string, target string) []string {
	result := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if argument != target {
			result = append(result, argument)
		}
	}
	return result
}

func replaceRecoveryArgument(arguments []string, name, value string) []string {
	result := append([]string(nil), arguments...)
	for index, argument := range result {
		if strings.HasPrefix(argument, name+"=") {
			result[index] = name + "=" + value
		}
	}
	return result
}

func recoveryDrillMustNotRun(t *testing.T) runRecoveryDrillFunction {
	t.Helper()
	return func(context.Context, string, string, operations.RecoveryDrillCommand) (operations.RecoveryDrillResult, error) {
		t.Fatal("recovery drill must not run")
		return operations.RecoveryDrillResult{}, nil
	}
}
