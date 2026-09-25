package cryptocontent_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

var errFakeKMS = errors.New("fake KMS failed")

func TestEnvelopeServiceRoundTripAndAuthenticationFailures(t *testing.T) {
	vaultA := mustVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := mustVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	versionOne, _ := cryptocontent.ParseDEKVersion(1)
	metadata := fixtureMetadata(vaultA, versionOne)
	keyring, _ := cryptocontent.NewVaultDEKKeyring(vaultA, versionOne, []cryptocontent.VaultDEKMetadata{metadata})
	reservations := &fakeReservations{seen: make(map[string]struct{})}
	service := mustService(t, &fakeKeys{metadata: metadata, bytes: bytesOf(0x11)}, &fakeNonces{
		values: [][]byte{make([]byte, 12)},
	}, reservations)
	contextA := objectContext(t, vaultA, "01991f20-61d2-7000-8000-000000000001", 1)
	plaintext := []byte("private title and body")
	ciphertext, err := service.Encrypt(context.Background(), keyring, contextA, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := service.Decrypt(context.Background(), keyring, contextA, ciphertext)
	if err != nil || string(opened) != string(plaintext) {
		t.Fatalf("Decrypt() = %q, %v", opened, err)
	}

	tampered := ciphertext
	tampered.SealedPayload = replaceFirstCharacter(tampered.SealedPayload)
	if _, err := service.Decrypt(context.Background(), keyring, contextA, tampered); !errors.Is(err, contentcrypto.ErrAuthenticationFailed) {
		t.Fatalf("tampered error = %v", err)
	}
	objectSwap := objectContext(t, vaultA, "01991f20-61d2-7000-8000-000000000002", 1)
	if _, err := service.Decrypt(context.Background(), keyring, objectSwap, ciphertext); !errors.Is(err, contentcrypto.ErrAuthenticationFailed) {
		t.Fatalf("object swap error = %v", err)
	}
	revisionSwap := objectContext(t, vaultA, contextA.ObjectID, 2)
	if _, err := service.Decrypt(context.Background(), keyring, revisionSwap, ciphertext); !errors.Is(err, contentcrypto.ErrAuthenticationFailed) {
		t.Fatalf("revision swap error = %v", err)
	}
	crossVault := contextA
	crossVault.VaultID = vaultB
	if _, err := service.Decrypt(context.Background(), keyring, crossVault, ciphertext); !errors.Is(err, cryptocontent.ErrEnvelopePolicy) {
		t.Fatalf("cross-vault error = %v", err)
	}
}

func TestEnvelopeServiceRetriesNonceCollisionAndFailsClosed(t *testing.T) {
	vaultID := mustVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(1)
	metadata := fixtureMetadata(vaultID, version)
	keyring, _ := cryptocontent.NewVaultDEKKeyring(vaultID, version, []cryptocontent.VaultDEKMetadata{metadata})
	reserved := &fakeReservations{seen: map[string]struct{}{
		string(vaultID) + ":1:AAAAAAAAAAAAAAAA": {},
	}}
	service := mustService(t, &fakeKeys{metadata: metadata, bytes: bytesOf(0x11)}, &fakeNonces{
		values: [][]byte{make([]byte, 12), bytesOfLength(0x01, 12)},
	}, reserved)
	ciphertext, err := service.Encrypt(
		context.Background(),
		keyring,
		objectContext(t, vaultID, "01991f20-61d2-7000-8000-000000000001", 1),
		[]byte("collision retry"),
	)
	if err != nil || ciphertext.Nonce != "AQEBAQEBAQEBAQEB" {
		t.Fatalf("Encrypt() nonce = %q, %v", ciphertext.Nonce, err)
	}

	failing := mustService(t, &fakeKeys{metadata: metadata, bytes: bytesOf(0x11), fail: true}, &fakeNonces{
		values: [][]byte{make([]byte, 12)},
	}, &fakeReservations{seen: make(map[string]struct{})})
	if _, err := failing.Encrypt(
		context.Background(), keyring,
		objectContext(t, vaultID, "01991f20-61d2-7000-8000-000000000001", 1),
		[]byte("no fallback"),
	); !errors.Is(err, errFakeKMS) {
		t.Fatalf("KMS failure error = %v", err)
	}
}

func mustService(
	t *testing.T,
	keys cryptocontent.KeyManagementPort,
	nonces cryptocontent.NonceGeneratorPort,
	reservations cryptocontent.NonceReservationPort,
) *cryptocontent.Service {
	t.Helper()
	service, err := cryptocontent.NewService(keys, nonces, reservations, contentcrypto.AES256GCM{})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type fakeKeys struct {
	metadata cryptocontent.VaultDEKMetadata
	bytes    []byte
	fail     bool
}

func (fake *fakeKeys) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	if fake.fail {
		return cryptocontent.VaultDEKMetadata{}, nil, errFakeKMS
	}
	key, err := cryptocontent.NewDataEncryptionKey(fake.bytes)
	return fake.metadata, key, err
}

func (fake *fakeKeys) UnwrapDataKey(
	context.Context,
	cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	if fake.fail {
		return nil, errFakeKMS
	}
	return cryptocontent.NewDataEncryptionKey(fake.bytes)
}

type fakeNonces struct {
	mutex  sync.Mutex
	values [][]byte
}

func (fake *fakeNonces) CreateNonce(context.Context) ([]byte, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if len(fake.values) == 0 {
		return nil, errors.New("fake nonce exhausted")
	}
	nonce := append([]byte(nil), fake.values[0]...)
	fake.values = fake.values[1:]
	return nonce, nil
}

type fakeReservations struct {
	mutex sync.Mutex
	seen  map[string]struct{}
}

func (fake *fakeReservations) ReserveNonce(
	_ context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
	nonce string,
) (bool, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	key := string(vaultID) + ":" + strconv.FormatInt(int64(version), 10) + ":" + nonce
	if _, exists := fake.seen[key]; exists {
		return false, nil
	}
	fake.seen[key] = struct{}{}
	return true, nil
}

func objectContext(
	t *testing.T,
	vaultID identity.VaultID,
	objectID string,
	revision int64,
) cryptocontent.ObjectContext {
	t.Helper()
	parsedRevision, err := cryptocontent.ParseObjectRevision(revision)
	if err != nil {
		t.Fatal(err)
	}
	return cryptocontent.ObjectContext{
		VaultID: vaultID, Kind: cryptocontent.ObjectCard,
		ObjectID: objectID, ObjectRevision: parsedRevision,
	}
}

func bytesOf(value byte) []byte { return bytesOfLength(value, 32) }

func bytesOfLength(value byte, length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = value
	}
	return result
}

func replaceFirstCharacter(value string) string {
	if value[0] == 'A' {
		return "B" + value[1:]
	}
	return "A" + value[1:]
}
