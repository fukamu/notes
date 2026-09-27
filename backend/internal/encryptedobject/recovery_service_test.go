package encryptedobject_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/recoverybackup"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestRecoveryServiceAuthenticatesMixedVersionsAndClearsPlaintext(t *testing.T) {
	fixture := newRecoveryServiceFixture(t)
	result := fixture.service.Run(context.Background(), fixture.manifest.RecoveryScope, 3_000)
	if result.Kind != encryptedobject.RecoveryResultVerified || result.Receipt == nil ||
		result.Receipt.ObjectCount != 2 || len(result.Receipt.VerifiedVersions) != 2 {
		t.Fatalf("Run() = %#v", result)
	}
	if calls := fixture.backup.Calls(); calls.Manifest != 1 || calls.Ciphertext != 2 {
		t.Fatalf("backup calls = %#v", calls)
	}
	if fixture.encryption.decryptCalls != 2 {
		t.Fatalf("decrypt calls = %d", fixture.encryption.decryptCalls)
	}
	for _, plaintext := range fixture.encryption.opened {
		for _, value := range plaintext {
			if value != 0 {
				t.Fatal("recovered plaintext was not cleared")
			}
		}
	}
	encoded, err := json.Marshal(result.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	if containsSensitiveRecoveryField(string(encoded)) {
		t.Fatalf("receipt contains content-bearing field: %s", encoded)
	}
}

func TestRecoveryServiceBlocksBeforeCiphertextForScopeCheckpointAndManifest(t *testing.T) {
	fixture := newRecoveryServiceFixture(t)
	foreign := fixture.manifest.RecoveryScope
	foreign.AccountID = mustRecoveryAccountID(t, "01991f20-61d2-7000-8000-000000001102")
	result := fixture.service.Run(context.Background(), foreign, 3_000)
	if result.Kind != encryptedobject.RecoveryResultBlocked || result.Reason != encryptedobject.RecoveryResultScopeMismatch ||
		fixture.backup.Calls().Ciphertext != 0 {
		t.Fatalf("foreign result/calls = %#v/%#v", result, fixture.backup.Calls())
	}

	pending := newRecoveryServiceFixtureWithManifest(t, func(manifest *encryptedobject.RecoveryManifest) {
		manifest.Reencryption = encryptedobject.RecoveryReencryptionPending{TargetVersion: 2}
	})
	result = pending.service.Run(context.Background(), pending.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryResultCheckpoint || pending.backup.Calls().Ciphertext != 0 {
		t.Fatalf("pending result/calls = %#v/%#v", result, pending.backup.Calls())
	}

	incompleteRotation := newRecoveryServiceFixtureWithManifest(t, func(manifest *encryptedobject.RecoveryManifest) {
		keyring, err := cryptocontent.NewVaultDEKKeyring(
			manifest.VaultID,
			1,
			manifest.Keyring.Versions,
		)
		if err != nil {
			t.Fatal(err)
		}
		manifest.Keyring = keyring
		manifest.Rotation.Revision = 2
		manifest.Rotation.UpdatedAtMilli = 2_000
		manifest.Rotation.State = cryptocontent.RotationPromoting{Metadata: manifest.Keyring.Versions[1]}
		manifest.Reencryption = encryptedobject.RecoveryReencryptionPending{TargetVersion: 2}
	})
	result = incompleteRotation.service.Run(context.Background(), incompleteRotation.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryResultRotation || incompleteRotation.backup.Calls().Ciphertext != 0 {
		t.Fatalf("rotation result/calls = %#v/%#v", result, incompleteRotation.backup.Calls())
	}

	invalid := newRecoveryServiceFixture(t)
	manifestBytes, err := encryptedobject.EncodeRecoveryManifest(invalid.manifest)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(manifestBytes, &raw); err != nil {
		t.Fatal(err)
	}
	raw["unknown"] = true
	invalidBytes, _ := json.Marshal(raw)
	invalidBackup, _ := recoverybackup.NewMemory(invalidBytes, nil)
	invalidService, _ := encryptedobject.NewRecoveryDrillService(invalidBackup, invalid.encryption)
	result = invalidService.Run(context.Background(), invalid.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryInvalidManifest || invalidBackup.Calls().Ciphertext != 0 {
		t.Fatalf("invalid manifest result/calls = %#v/%#v", result, invalidBackup.Calls())
	}

	missingKey := newRecoveryServiceFixture(t)
	manifestBytes, err = encryptedobject.EncodeRecoveryManifest(missingKey.manifest)
	if err != nil {
		t.Fatal(err)
	}
	raw = make(map[string]any)
	if err := json.Unmarshal(manifestBytes, &raw); err != nil {
		t.Fatal(err)
	}
	keyring := raw["keyring"].(map[string]any)
	versions := keyring["versions"].([]any)
	keyring["versions"] = versions[1:]
	missingKeyBytes, _ := json.Marshal(raw)
	missingKeyBackup, _ := recoverybackup.NewMemory(missingKeyBytes, nil)
	missingKeyService, _ := encryptedobject.NewRecoveryDrillService(missingKeyBackup, missingKey.encryption)
	result = missingKeyService.Run(context.Background(), missingKey.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryInvalidManifest || missingKeyBackup.Calls().Ciphertext != 0 {
		t.Fatalf("missing key result/calls = %#v/%#v", result, missingKeyBackup.Calls())
	}
}

func TestRecoveryServiceFailsClosedForBackupAndObjectFailures(t *testing.T) {
	manifestFailure := newRecoveryServiceFixture(t)
	manifestFailure.backup.FailNext(recoverybackup.OperationManifest)
	if result := manifestFailure.service.Run(context.Background(), manifestFailure.manifest.RecoveryScope, 3_000); result.Reason != encryptedobject.RecoveryBackupUnavailable {
		t.Fatalf("manifest failure = %#v", result)
	}

	ciphertextFailure := newRecoveryServiceFixture(t)
	ciphertextFailure.backup.FailNext(recoverybackup.OperationCiphertext)
	if result := ciphertextFailure.service.Run(context.Background(), ciphertextFailure.manifest.RecoveryScope, 3_000); result.Reason != encryptedobject.RecoveryBackupUnavailable {
		t.Fatalf("ciphertext failure = %#v", result)
	}

	missing := newRecoveryServiceFixtureWithSeeds(t, func(seeds []recoverybackup.Seed) []recoverybackup.Seed {
		return seeds[1:]
	})
	if result := missing.service.Run(context.Background(), missing.manifest.RecoveryScope, 3_000); result.Reason != encryptedobject.RecoveryMissingObject {
		t.Fatalf("missing object = %#v", result)
	}

	malformed := newRecoveryServiceFixture(t)
	if err := malformed.backup.ReplaceForTest(malformed.manifest.BackupID, malformed.manifest.Objects[0].ObjectKey, []byte("not-envelope-json")); err != nil {
		t.Fatal(err)
	}
	if result := malformed.service.Run(context.Background(), malformed.manifest.RecoveryScope, 3_000); result.Reason != encryptedobject.RecoveryInvalidCiphertext {
		t.Fatalf("malformed object = %#v", result)
	}
}

func TestRecoveryServiceRejectsTamperSwapAndWrongKeyWithoutReceipt(t *testing.T) {
	tampered := newRecoveryServiceFixture(t)
	var ciphertext cryptocontent.EnvelopeCiphertext
	if err := json.Unmarshal(tampered.encoded[0], &ciphertext); err != nil {
		t.Fatal(err)
	}
	ciphertext.SealedPayload = replaceRecoveryFirstCharacter(ciphertext.SealedPayload)
	tamperedBytes, _ := json.Marshal(ciphertext)
	if len(tamperedBytes) != len(tampered.encoded[0]) {
		t.Fatal("tamper fixture changed encoded length")
	}
	if err := tampered.backup.ReplaceForTest(tampered.manifest.BackupID, tampered.manifest.Objects[0].ObjectKey, tamperedBytes); err != nil {
		t.Fatal(err)
	}
	result := tampered.service.Run(context.Background(), tampered.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryAuthenticationFailed || result.Receipt != nil {
		t.Fatalf("tampered result = %#v", result)
	}

	swapped := newRecoveryServiceFixture(t)
	if len(swapped.encoded[0]) != len(swapped.swapCiphertext) {
		t.Fatal("swap fixture ciphertext lengths differ")
	}
	if err := swapped.backup.ReplaceForTest(swapped.manifest.BackupID, swapped.manifest.Objects[0].ObjectKey, swapped.swapCiphertext); err != nil {
		t.Fatal(err)
	}
	result = swapped.service.Run(context.Background(), swapped.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryAuthenticationFailed || result.Receipt != nil {
		t.Fatalf("swapped result = %#v", result)
	}

	wrongKey := newRecoveryServiceFixture(t)
	badCrypto, err := cryptocontent.NewService(
		wrongRecoveryKeys{}, &fakeNonces{}, &fakeReservations{seen: make(map[string]struct{})}, contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	badService, _ := encryptedobject.NewRecoveryDrillService(wrongKey.backup, badCrypto)
	result = badService.Run(context.Background(), wrongKey.manifest.RecoveryScope, 3_000)
	if result.Reason != encryptedobject.RecoveryAuthenticationFailed || result.Receipt != nil {
		t.Fatalf("wrong key result = %#v", result)
	}
}

type recoveryServiceFixture struct {
	manifest       encryptedobject.RecoveryManifest
	backup         *recoverybackup.Memory
	encryption     *observedRecoveryEncryption
	service        *encryptedobject.RecoveryDrillService
	encoded        [][]byte
	swapCiphertext []byte
	seeds          []recoverybackup.Seed
}

func newRecoveryServiceFixture(t *testing.T) recoveryServiceFixture {
	return newRecoveryServiceFixtureWithSeedsAndManifest(t, nil, nil)
}

func newRecoveryServiceFixtureWithManifest(
	t *testing.T,
	mutate func(*encryptedobject.RecoveryManifest),
) recoveryServiceFixture {
	return newRecoveryServiceFixtureWithSeedsAndManifest(t, nil, mutate)
}

func newRecoveryServiceFixtureWithSeeds(
	t *testing.T,
	mutate func([]recoverybackup.Seed) []recoverybackup.Seed,
) recoveryServiceFixture {
	return newRecoveryServiceFixtureWithSeedsAndManifest(t, mutate, nil)
}

func newRecoveryServiceFixtureWithSeedsAndManifest(
	t *testing.T,
	mutateSeeds func([]recoverybackup.Seed) []recoverybackup.Seed,
	mutateManifest func(*encryptedobject.RecoveryManifest),
) recoveryServiceFixture {
	t.Helper()
	manifest := recoveryManifestFixture(t)
	oldKeyring, err := cryptocontent.NewVaultDEKKeyring(
		manifest.VaultID,
		1,
		[]cryptocontent.VaultDEKMetadata{manifest.Keyring.Versions[0]},
	)
	if err != nil {
		t.Fatal(err)
	}
	cryptoService, err := cryptocontent.NewService(
		&fakeKeyManagement{metadata: manifest.Keyring.Versions[0]},
		&fakeNonces{},
		&fakeReservations{seen: make(map[string]struct{})},
		contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("same-size-secret")
	encoded := make([][]byte, 2)
	for index := range manifest.Objects {
		contextValue := cryptocontent.ObjectContext{
			VaultID: manifest.VaultID, Kind: manifest.Objects[index].Object.Kind,
			ObjectID:       manifest.Objects[index].Object.ObjectID,
			ObjectRevision: manifest.Objects[index].ObjectRevision,
		}
		keyring := manifest.Keyring
		if index == 0 {
			keyring = oldKeyring
		}
		ciphertext, err := cryptoService.Encrypt(context.Background(), keyring, contextValue, plaintext)
		if err != nil {
			t.Fatal(err)
		}
		encoded[index], err = json.Marshal(ciphertext)
		if err != nil {
			t.Fatal(err)
		}
		manifest.Objects[index].PlaintextBytes = int64(len(plaintext))
		manifest.Objects[index].CiphertextBytes = int64(len(encoded[index]))
	}
	swapContext := cryptocontent.ObjectContext{
		VaultID: manifest.VaultID, Kind: manifest.Objects[1].Object.Kind,
		ObjectID:       manifest.Objects[1].Object.ObjectID,
		ObjectRevision: manifest.Objects[1].ObjectRevision,
	}
	swapEnvelope, err := cryptoService.Encrypt(context.Background(), oldKeyring, swapContext, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	swapCiphertext, err := json.Marshal(swapEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if mutateManifest != nil {
		mutateManifest(&manifest)
	}
	manifestBytes, err := encryptedobject.EncodeRecoveryManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	seeds := []recoverybackup.Seed{
		{BackupID: manifest.BackupID, ObjectKey: manifest.Objects[0].ObjectKey, Bytes: encoded[0]},
		{BackupID: manifest.BackupID, ObjectKey: manifest.Objects[1].ObjectKey, Bytes: encoded[1]},
	}
	if mutateSeeds != nil {
		seeds = mutateSeeds(seeds)
	}
	backup, err := recoverybackup.NewMemory(manifestBytes, seeds)
	if err != nil {
		t.Fatal(err)
	}
	observed := &observedRecoveryEncryption{base: cryptoService}
	service, err := encryptedobject.NewRecoveryDrillService(backup, observed)
	if err != nil {
		t.Fatal(err)
	}
	return recoveryServiceFixture{
		manifest: manifest, backup: backup, encryption: observed, service: service,
		encoded: encoded, swapCiphertext: swapCiphertext, seeds: seeds,
	}
}

type observedRecoveryEncryption struct {
	base         encryptedobject.EncryptionPort
	decryptCalls int
	opened       [][]byte
}

func (observed *observedRecoveryEncryption) Encrypt(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	object cryptocontent.ObjectContext,
	plaintext []byte,
) (cryptocontent.EnvelopeCiphertext, error) {
	return observed.base.Encrypt(ctx, keyring, object, plaintext)
}

func (observed *observedRecoveryEncryption) Decrypt(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	object cryptocontent.ObjectContext,
	ciphertext cryptocontent.EnvelopeCiphertext,
) ([]byte, error) {
	observed.decryptCalls++
	plaintext, err := observed.base.Decrypt(ctx, keyring, object, ciphertext)
	if plaintext != nil {
		observed.opened = append(observed.opened, plaintext)
	}
	return plaintext, err
}

type wrongRecoveryKeys struct{}

func (wrongRecoveryKeys) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.VaultDEKMetadata{}, nil, errors.New("unexpected generate")
}

func (wrongRecoveryKeys) UnwrapDataKey(
	context.Context,
	cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.NewDataEncryptionKey(bytesFilledWith(0xff, 32))
}

func bytesFilledWith(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}

func replaceRecoveryFirstCharacter(value string) string {
	if value[0] == 'A' {
		return "B" + value[1:]
	}
	return "A" + value[1:]
}

func containsSensitiveRecoveryField(value string) bool {
	for _, field := range []string{"ObjectKey", "WrappedDEK", "Plaintext", "Ciphertext"} {
		if strings.Contains(value, field) {
			return true
		}
	}
	return false
}
