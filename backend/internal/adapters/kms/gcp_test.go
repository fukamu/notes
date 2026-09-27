package kms

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	testKeyName        = "projects/fukamu-test/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/vault-kek"
	testKeyVersionName = testKeyName + "/cryptoKeyVersions/7"
)

func TestGCPKeyManagementWrapsAndUnwrapsWithAuthenticatedContext(t *testing.T) {
	vaultID := testVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(1)
	transport := &authenticatedTransport{}
	source := testKeyBytes()
	adapter, err := NewGCPKeyManagement(
		testKeyVersionName,
		transport,
		&fixedEntropy{value: source},
		fixedClock(1_725_000_000_000),
	)
	if err != nil {
		t.Fatal(err)
	}
	metadata, generated, err := adapter.GenerateDataKey(context.Background(), vaultID, version)
	if err != nil {
		t.Fatal(err)
	}
	defer generated.Destroy()
	if !bytes.Equal(source, make([]byte, 32)) {
		t.Fatalf("entropy source was not zeroized: %v", source)
	}
	if metadata.VaultID != vaultID || metadata.DEKVersion != version ||
		metadata.KEKReference != testKeyVersionName || metadata.CreatedAtMilli != 1_725_000_000_000 {
		t.Fatalf("metadata = %#v", metadata)
	}
	wantAAD, _ := cryptocontent.SerializeWrappedDEKAAD(vaultID, version, testKeyVersionName)
	if len(transport.encryptCalls) != 1 ||
		decodeBase64String(t, transport.encryptCalls[0].AdditionalAuthenticatedData) != wantAAD {
		t.Fatalf("encrypt AAD = %#v", transport.encryptCalls)
	}
	assertKeyBytes(t, generated, testKeyBytes())

	unwrapped, err := adapter.UnwrapDataKey(context.Background(), metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer unwrapped.Destroy()
	assertKeyBytes(t, unwrapped, testKeyBytes())
	if len(transport.decryptCalls) != 1 || transport.decryptCalls[0].KeyName != testKeyName {
		t.Fatalf("decrypt calls = %#v", transport.decryptCalls)
	}

	tampered := metadata
	tampered.VaultID = testVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	if _, err := adapter.UnwrapDataKey(context.Background(), tampered); !errors.Is(err, ErrGCPOperation) {
		t.Fatalf("tampered Vault error = %v", err)
	}
	otherKey := metadata
	otherKey.KEKReference = "projects/fukamu-test/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/other/cryptoKeyVersions/7"
	if _, err := adapter.UnwrapDataKey(context.Background(), otherKey); !errors.Is(err, ErrGCPOperation) {
		t.Fatalf("other key error = %v", err)
	}
}

func TestGCPKeyManagementRejectsIntegrityFailuresWithoutSecrets(t *testing.T) {
	vaultID := testVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(1)
	sensitive := "PRIVATE-PROVIDER-FAILURE"
	adapter, err := NewGCPKeyManagement(
		testKeyVersionName,
		failingTransport{err: errors.New(sensitive)},
		&fixedEntropy{value: testKeyBytes()},
		fixedClock(1_725_000_000_000),
	)
	if err != nil {
		t.Fatal(err)
	}
	_, _, failure := adapter.GenerateDataKey(context.Background(), vaultID, version)
	if !errors.Is(failure, ErrGCPOperation) || strings.Contains(failure.Error(), sensitive) ||
		strings.Contains(failure.Error(), base64.StdEncoding.EncodeToString(testKeyBytes())) {
		t.Fatalf("unsafe failure = %v", failure)
	}

	corrupt := &authenticatedTransport{corruptEncryptCRC: true}
	corruptAdapter, _ := NewGCPKeyManagement(
		testKeyVersionName,
		corrupt,
		&fixedEntropy{value: testKeyBytes()},
		fixedClock(1_725_000_000_000),
	)
	if _, _, err := corruptAdapter.GenerateDataKey(context.Background(), vaultID, version); !errors.Is(err, ErrGCPOperation) {
		t.Fatalf("corrupt checksum error = %v", err)
	}

	unverified := &authenticatedTransport{unverified: true}
	unverifiedAdapter, _ := NewGCPKeyManagement(
		testKeyVersionName,
		unverified,
		&fixedEntropy{value: testKeyBytes()},
		fixedClock(1_725_000_000_000),
	)
	if _, _, err := unverifiedAdapter.GenerateDataKey(context.Background(), vaultID, version); !errors.Is(err, ErrGCPOperation) {
		t.Fatalf("unverified response error = %v", err)
	}

	if _, err := NewGCPKeyManagement(testKeyName+"/cryptoKeyVersions/0", corrupt, &fixedEntropy{}, fixedClock(0)); !errors.Is(err, ErrGCPConfiguration) {
		t.Fatalf("configuration error = %v", err)
	}
}

func TestRESTTransportUsesExactEndpointsAndFailsClosed(t *testing.T) {
	token := "sensitive-access-token-value"
	doer := &recordingDoer{response: `{"provider":"response"}`}
	transport, err := NewRESTTransport(fixedToken(token), doer)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transport.Encrypt(context.Background(), EncryptRequest{
		KeyVersionName:                    testKeyVersionName,
		Plaintext:                         "AQ==",
		AdditionalAuthenticatedData:       "Ag==",
		PlaintextCRC32C:                   "1",
		AdditionalAuthenticatedDataCRC32C: "2",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = transport.Decrypt(context.Background(), DecryptRequest{
		KeyName:                           testKeyName,
		Ciphertext:                        "Aw==",
		AdditionalAuthenticatedData:       "Ag==",
		CiphertextCRC32C:                  "3",
		AdditionalAuthenticatedDataCRC32C: "2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(doer.requests) != 2 ||
		doer.requests[0].URL.String() != gcpCloudKMSEndpoint+"/"+testKeyVersionName+":encrypt" ||
		doer.requests[1].URL.String() != gcpCloudKMSEndpoint+"/"+testKeyName+":decrypt" {
		t.Fatalf("request URLs = %#v", doer.requests)
	}
	if doer.requests[0].Header.Get("Authorization") != "Bearer "+token {
		t.Fatal("missing authorization header")
	}

	privateProviderBody := "PRIVATE PROVIDER BODY"
	failing, _ := NewRESTTransport(fixedToken(token), &recordingDoer{
		status:   http.StatusTooManyRequests,
		response: privateProviderBody,
	})
	_, failure := failing.Encrypt(context.Background(), testEncryptRequest())
	if !errors.Is(failure, ErrGCPOperation) || strings.Contains(failure.Error(), token) ||
		strings.Contains(failure.Error(), privateProviderBody) {
		t.Fatalf("unsafe REST failure = %v", failure)
	}

	blocking, _ := NewRESTTransport(fixedToken(token), waitingDoer{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, failure = blocking.Decrypt(ctx, testDecryptRequest())
	if !errors.Is(failure, ErrGCPOperation) {
		t.Fatalf("timeout error = %v", failure)
	}
	if _, err := transport.Encrypt(context.Background(), EncryptRequest{
		KeyVersionName: "../private-endpoint",
	}); !errors.Is(err, ErrGCPOperation) {
		t.Fatalf("invalid endpoint error = %v", err)
	}
}

type fixedEntropy struct{ value []byte }

func (entropy *fixedEntropy) CreateDataKeyBytes(context.Context) ([]byte, error) {
	return entropy.value, nil
}

type fixedClock int64

func (clock fixedClock) NowMillis() int64 { return int64(clock) }

type authenticatedTransport struct {
	encryptCalls      []EncryptRequest
	decryptCalls      []DecryptRequest
	expectedAAD       string
	expectedPlaintext string
	corruptEncryptCRC bool
	unverified        bool
}

func (transport *authenticatedTransport) Encrypt(_ context.Context, command EncryptRequest) (json.RawMessage, error) {
	transport.encryptCalls = append(transport.encryptCalls, command)
	transport.expectedAAD = command.AdditionalAuthenticatedData
	transport.expectedPlaintext = command.Plaintext
	wrapped := []byte("wrapped-dek-ciphertext")
	crc := checksum(wrapped)
	if transport.corruptEncryptCRC {
		crc++
	}
	return json.Marshal(map[string]any{
		"name":                    command.KeyVersionName,
		"ciphertext":              base64.StdEncoding.EncodeToString(wrapped),
		"ciphertextCrc32c":        fmt.Sprint(crc),
		"verifiedPlaintextCrc32c": !transport.unverified,
		"verifiedAdditionalAuthenticatedDataCrc32c": true,
	})
}

func (transport *authenticatedTransport) Decrypt(_ context.Context, command DecryptRequest) (json.RawMessage, error) {
	transport.decryptCalls = append(transport.decryptCalls, command)
	if command.AdditionalAuthenticatedData != transport.expectedAAD {
		return nil, errors.New("authenticated context mismatch")
	}
	plaintext, err := base64.StdEncoding.Strict().DecodeString(transport.expectedPlaintext)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"plaintext":       transport.expectedPlaintext,
		"plaintextCrc32c": fmt.Sprint(checksum(plaintext)),
	})
}

type failingTransport struct{ err error }

func (transport failingTransport) Encrypt(context.Context, EncryptRequest) (json.RawMessage, error) {
	return nil, transport.err
}
func (transport failingTransport) Decrypt(context.Context, DecryptRequest) (json.RawMessage, error) {
	return nil, transport.err
}

type fixedToken string

func (token fixedToken) ReadAccessToken(context.Context) (string, error) { return string(token), nil }

type recordingDoer struct {
	requests []*http.Request
	status   int
	response string
}

func (doer *recordingDoer) Do(request *http.Request) (*http.Response, error) {
	doer.requests = append(doer.requests, request.Clone(request.Context()))
	status := doer.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(doer.response)),
		Header:     make(http.Header),
	}, nil
}

type waitingDoer struct{}

func (waitingDoer) Do(request *http.Request) (*http.Response, error) {
	<-request.Context().Done()
	return nil, request.Context().Err()
}

func testVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func testKeyBytes() []byte {
	value := make([]byte, 32)
	for index := range value {
		value[index] = byte(index + 1)
	}
	return value
}

func assertKeyBytes(t *testing.T, key *cryptocontent.DataEncryptionKey, expected []byte) {
	t.Helper()
	if err := key.Use(func(actual []byte) error {
		if !bytes.Equal(actual, expected) {
			return errors.New("key mismatch")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func decodeBase64String(t *testing.T, value string) string {
	t.Helper()
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(decoded)
}

func testEncryptRequest() EncryptRequest {
	return EncryptRequest{
		KeyVersionName:                    testKeyVersionName,
		Plaintext:                         "AQ==",
		AdditionalAuthenticatedData:       "Ag==",
		PlaintextCRC32C:                   "1",
		AdditionalAuthenticatedDataCRC32C: "2",
	}
}

func testDecryptRequest() DecryptRequest {
	return DecryptRequest{
		KeyName:                           testKeyName,
		Ciphertext:                        "Aw==",
		AdditionalAuthenticatedData:       "Ag==",
		CiphertextCRC32C:                  "3",
		AdditionalAuthenticatedDataCRC32C: "2",
	}
}
