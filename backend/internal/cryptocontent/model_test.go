package cryptocontent_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

type envelopeFixture struct {
	Profile            string                           `json:"profile"`
	KeyBase64URL       string                           `json:"keyBase64Url"`
	PlaintextBase64URL string                           `json:"plaintextBase64Url"`
	Ciphertext         cryptocontent.EnvelopeCiphertext `json:"ciphertext"`
	AAD                struct {
		VaultID        string `json:"vaultId"`
		ObjectKind     string `json:"objectKind"`
		ObjectID       string `json:"objectId"`
		ObjectRevision int64  `json:"objectRevision"`
		DEKVersion     int64  `json:"dekVersion"`
		Canonical      string `json:"canonical"`
	} `json:"aad"`
	WrappedDEKAAD struct {
		VaultID        string `json:"vaultId"`
		DEKVersion     int64  `json:"dekVersion"`
		KeyVersionName string `json:"keyVersionName"`
		Canonical      string `json:"canonical"`
	} `json:"wrappedDekAad"`
	Tampered json.RawMessage `json:"tampered"`
}

func TestSharedEnvelopeVector(t *testing.T) {
	fixture := readEnvelopeFixture(t)
	vaultID, err := identity.ParseVaultID(fixture.AAD.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	version, err := cryptocontent.ParseDEKVersion(fixture.AAD.DEKVersion)
	if err != nil {
		t.Fatal(err)
	}
	revision, err := cryptocontent.ParseObjectRevision(fixture.AAD.ObjectRevision)
	if err != nil {
		t.Fatal(err)
	}
	object := cryptocontent.ObjectContext{
		VaultID: vaultID, Kind: cryptocontent.ObjectKind(fixture.AAD.ObjectKind),
		ObjectID: fixture.AAD.ObjectID, ObjectRevision: revision,
	}
	aad, err := cryptocontent.SerializeEnvelopeAAD(object, version)
	if err != nil || aad != fixture.AAD.Canonical {
		t.Fatalf("SerializeEnvelopeAAD() = %q, %v", aad, err)
	}
	wrappedAAD, err := cryptocontent.SerializeWrappedDEKAAD(
		vaultID,
		version,
		fixture.WrappedDEKAAD.KeyVersionName,
	)
	if err != nil || wrappedAAD != fixture.WrappedDEKAAD.Canonical {
		t.Fatalf("SerializeWrappedDEKAAD() = %q, %v", wrappedAAD, err)
	}

	keyBytes, err := base64.RawURLEncoding.Strict().DecodeString(fixture.KeyBase64URL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := cryptocontent.NewDataEncryptionKey(keyBytes)
	clear(keyBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Destroy()
	plaintext, err := base64.RawURLEncoding.Strict().DecodeString(fixture.PlaintextBase64URL)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := (contentcrypto.AES256GCM{}).Seal(
		key,
		fixture.Ciphertext.Nonce,
		aad,
		plaintext,
	)
	if err != nil || sealed != fixture.Ciphertext.SealedPayload {
		t.Fatalf("Seal() = %q, %v", sealed, err)
	}
	opened, err := (contentcrypto.AES256GCM{}).Open(
		key,
		fixture.Ciphertext.Nonce,
		aad,
		fixture.Ciphertext.SealedPayload,
	)
	if err != nil || string(opened) != string(plaintext) {
		t.Fatalf("Open() = %q, %v", opened, err)
	}
	clear(opened)
	clear(plaintext)

	ciphertextJSON, err := json.Marshal(fixture.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := cryptocontent.DecodeEnvelopeCiphertext(ciphertextJSON)
	if err != nil || decoded != fixture.Ciphertext {
		t.Fatalf("DecodeEnvelopeCiphertext() = %#v, %v", decoded, err)
	}
	if _, err := cryptocontent.DecodeEnvelopeCiphertext(fixture.Tampered); !errors.Is(err, cryptocontent.ErrInvalidEnvelope) {
		t.Fatalf("tampered decode error = %v", err)
	}
	withUnknown := append([]byte(nil), ciphertextJSON[:len(ciphertextJSON)-1]...)
	withUnknown = append(withUnknown, []byte(`,"plaintext":"secret"}`)...)
	for _, malformed := range [][]byte{
		withUnknown,
		append(append([]byte(nil), ciphertextJSON...), []byte(` {}`)...),
	} {
		if _, err := cryptocontent.DecodeEnvelopeCiphertext(malformed); !errors.Is(err, cryptocontent.ErrInvalidEnvelope) {
			t.Fatalf("malformed decode error = %v", err)
		}
	}
}

func TestKeyringAndKeyMaterialFailClosed(t *testing.T) {
	vaultA := mustVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := mustVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	versionOne, _ := cryptocontent.ParseDEKVersion(1)
	versionTwo, _ := cryptocontent.ParseDEKVersion(2)
	metadata := fixtureMetadata(vaultA, versionOne)
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultA, versionOne, []cryptocontent.VaultDEKMetadata{metadata})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keyring.SelectForWrite(vaultB); !errors.Is(err, cryptocontent.ErrVaultMismatch) {
		t.Fatalf("cross-vault selection error = %v", err)
	}
	if _, err := keyring.SelectForRead(vaultA, versionTwo); !errors.Is(err, cryptocontent.ErrUnknownDEKVersion) {
		t.Fatalf("unknown-version selection error = %v", err)
	}
	if _, err := cryptocontent.NewVaultDEKKeyring(vaultA, versionTwo, []cryptocontent.VaultDEKMetadata{metadata}); !errors.Is(err, cryptocontent.ErrInvalidEnvelope) {
		t.Fatalf("missing write version error = %v", err)
	}
	invalidKeyring := cryptocontent.VaultDEKKeyring{
		VaultID: vaultA, WriteVersion: versionTwo,
		Versions: []cryptocontent.VaultDEKMetadata{metadata},
	}
	if _, err := invalidKeyring.SelectForWrite(vaultA); !errors.Is(err, cryptocontent.ErrInvalidEnvelope) {
		t.Fatalf("constructed invalid keyring error = %v", err)
	}

	raw := make([]byte, 32)
	for index := range raw {
		raw[index] = byte(index + 1)
	}
	key, err := cryptocontent.NewDataEncryptionKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(key) != "[REDACTED data encryption key]" {
		t.Fatalf("String() exposed key: %s", key)
	}
	encoded, err := json.Marshal(key)
	if err != nil || string(encoded) != `"[REDACTED data encryption key]"` {
		t.Fatalf("MarshalJSON() = %s, %v", encoded, err)
	}
	key.Destroy()
	if err := key.Use(func([]byte) error { return nil }); !errors.Is(err, cryptocontent.ErrDataEncryptionKeyUnavailable) {
		t.Fatalf("Use() after Destroy() error = %v", err)
	}
}

func TestDataEncryptionKeyConcurrentUseAndDestroy(t *testing.T) {
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index := 0; index < 16; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			for attempt := 0; attempt < 100; attempt++ {
				err := key.Use(func(bytes []byte) error {
					if len(bytes) != 32 {
						return errors.New("invalid key copy")
					}
					return nil
				})
				if err != nil && !errors.Is(err, cryptocontent.ErrDataEncryptionKeyUnavailable) {
					t.Errorf("Use() error = %v", err)
					return
				}
			}
		}()
	}
	close(start)
	key.Destroy()
	wait.Wait()
	if !key.Destroyed() {
		t.Fatal("key remained available after Destroy")
	}
}

func readEnvelopeFixture(t *testing.T) envelopeFixture {
	t.Helper()
	source, err := os.ReadFile("../../../contracts/fixtures/crypto/envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture envelopeFixture
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func mustVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func fixtureMetadata(vaultID identity.VaultID, version cryptocontent.DEKVersion) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID:        vaultID,
		DEKVersion:     version,
		KEKReference:   "projects/fukamu-test/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/vault-kek/cryptoKeyVersions/7",
		WrappedDEK:     "ZmFrZS13cmFwcGVkLWRlaw",
		CreatedAtMilli: 1_000,
	}
}
