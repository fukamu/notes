package kms

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"regexp"
	"strconv"
	"time"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

const dataEncryptionKeyLength = 32

var (
	ErrGCPConfiguration     = errors.New("GCP Cloud KMS configuration is unavailable")
	ErrGCPOperation         = errors.New("GCP Cloud KMS operation failed")
	cryptoKeyVersionPattern = regexp.MustCompile(
		`^(projects/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})/locations/[a-z0-9-]{1,63}/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63})/cryptoKeyVersions/[1-9][0-9]{0,18}$`,
	)
	unsignedDecimalPattern = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
	castagnoliTable        = crc32.MakeTable(crc32.Castagnoli)
)

type EncryptRequest struct {
	KeyVersionName                    string
	Plaintext                         string
	AdditionalAuthenticatedData       string
	PlaintextCRC32C                   string
	AdditionalAuthenticatedDataCRC32C string
}

type DecryptRequest struct {
	KeyName                           string
	Ciphertext                        string
	AdditionalAuthenticatedData       string
	CiphertextCRC32C                  string
	AdditionalAuthenticatedDataCRC32C string
}

type Transport interface {
	Encrypt(context.Context, EncryptRequest) (json.RawMessage, error)
	Decrypt(context.Context, DecryptRequest) (json.RawMessage, error)
}

type Entropy interface {
	CreateDataKeyBytes(context.Context) ([]byte, error)
}

type Clock interface {
	NowMillis() int64
}

type SystemClock struct{}

func (SystemClock) NowMillis() int64 { return time.Now().UnixMilli() }

type SecureEntropy struct{}

func (SecureEntropy) CreateDataKeyBytes(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, ErrGCPOperation
	}
	value := make([]byte, dataEncryptionKeyLength)
	if _, err := rand.Read(value); err != nil {
		clear(value)
		return nil, ErrGCPOperation
	}
	return value, nil
}

type GCPKeyManagement struct {
	keyName        string
	keyVersionName string
	transport      Transport
	entropy        Entropy
	clock          Clock
}

func NewGCPKeyManagement(
	cryptoKeyVersionResource string,
	transport Transport,
	entropy Entropy,
	clock Clock,
) (*GCPKeyManagement, error) {
	keyName, versionName, err := parseCryptoKeyVersionResource(cryptoKeyVersionResource)
	if err != nil || transport == nil || entropy == nil || clock == nil {
		return nil, ErrGCPConfiguration
	}
	return &GCPKeyManagement{
		keyName: keyName, keyVersionName: versionName,
		transport: transport, entropy: entropy, clock: clock,
	}, nil
}

func (adapter *GCPKeyManagement) GenerateDataKey(
	ctx context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	if adapter == nil || ctx == nil {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	rawKey, err := adapter.entropy.CreateDataKeyBytes(ctx)
	if err != nil || len(rawKey) != dataEncryptionKeyLength {
		clear(rawKey)
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	defer clear(rawKey)
	createdAt := adapter.clock.NowMillis()
	if createdAt < 0 || createdAt > cryptocontent.MaximumSafeInteger {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	aadValue, err := cryptocontent.SerializeWrappedDEKAAD(vaultID, version, adapter.keyVersionName)
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	aad := []byte(aadValue)
	responseBody, err := adapter.transport.Encrypt(ctx, EncryptRequest{
		KeyVersionName:                    adapter.keyVersionName,
		Plaintext:                         encodeBase64(rawKey),
		AdditionalAuthenticatedData:       encodeBase64(aad),
		PlaintextCRC32C:                   strconv.FormatUint(uint64(checksum(rawKey)), 10),
		AdditionalAuthenticatedDataCRC32C: strconv.FormatUint(uint64(checksum(aad)), 10),
	})
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	response, err := decodeEncryptResponse(responseBody)
	if err != nil || response.Name != adapter.keyVersionName ||
		!response.VerifiedPlaintextCRC32C || !response.VerifiedAADCRC32C {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	wrapped, err := decodeCanonicalBase64(response.Ciphertext, cryptocontent.MaximumWrappedDEKSize)
	if err != nil || checksum(wrapped) != response.CiphertextCRC32C {
		clear(wrapped)
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	wrappedValue := cryptocontent.EncodeBase64URL(wrapped)
	clear(wrapped)
	metadata := cryptocontent.VaultDEKMetadata{
		VaultID:        vaultID,
		DEKVersion:     version,
		KEKReference:   adapter.keyVersionName,
		WrappedDEK:     wrappedValue,
		CreatedAtMilli: createdAt,
	}
	if cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	key, err := cryptocontent.NewDataEncryptionKey(rawKey)
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, nil, ErrGCPOperation
	}
	return metadata, key, nil
}

func (adapter *GCPKeyManagement) UnwrapDataKey(
	ctx context.Context,
	metadata cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	if adapter == nil || ctx == nil || cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
		return nil, ErrGCPOperation
	}
	keyName, _, err := parseCryptoKeyVersionResource(metadata.KEKReference)
	if err != nil || keyName != adapter.keyName {
		return nil, ErrGCPOperation
	}
	wrapped, err := cryptocontent.DecodeCanonicalBase64URL(
		metadata.WrappedDEK,
		1,
		cryptocontent.MaximumWrappedDEKSize,
	)
	if err != nil {
		return nil, ErrGCPOperation
	}
	defer clear(wrapped)
	aadValue, err := cryptocontent.SerializeWrappedDEKAAD(
		metadata.VaultID,
		metadata.DEKVersion,
		metadata.KEKReference,
	)
	if err != nil {
		return nil, ErrGCPOperation
	}
	aad := []byte(aadValue)
	responseBody, err := adapter.transport.Decrypt(ctx, DecryptRequest{
		KeyName:                           adapter.keyName,
		Ciphertext:                        encodeBase64(wrapped),
		AdditionalAuthenticatedData:       encodeBase64(aad),
		CiphertextCRC32C:                  strconv.FormatUint(uint64(checksum(wrapped)), 10),
		AdditionalAuthenticatedDataCRC32C: strconv.FormatUint(uint64(checksum(aad)), 10),
	})
	if err != nil {
		return nil, ErrGCPOperation
	}
	response, err := decodeDecryptResponse(responseBody)
	if err != nil {
		return nil, ErrGCPOperation
	}
	plaintext, err := decodeCanonicalBase64(response.Plaintext, 64)
	if err != nil || len(plaintext) != dataEncryptionKeyLength || checksum(plaintext) != response.PlaintextCRC32C {
		clear(plaintext)
		return nil, ErrGCPOperation
	}
	defer clear(plaintext)
	key, err := cryptocontent.NewDataEncryptionKey(plaintext)
	if err != nil {
		return nil, ErrGCPOperation
	}
	return key, nil
}

type encryptResponse struct {
	Name                    string
	Ciphertext              string
	CiphertextCRC32C        uint32
	VerifiedPlaintextCRC32C bool
	VerifiedAADCRC32C       bool
}

func decodeEncryptResponse(body []byte) (encryptResponse, error) {
	var wire struct {
		Name                    string `json:"name"`
		Ciphertext              string `json:"ciphertext"`
		CiphertextCRC32C        string `json:"ciphertextCrc32c"`
		VerifiedPlaintextCRC32C bool   `json:"verifiedPlaintextCrc32c"`
		VerifiedAADCRC32C       bool   `json:"verifiedAdditionalAuthenticatedDataCrc32c"`
	}
	if decodeJSON(body, &wire) != nil || len(wire.Name) < 1 || len(wire.Name) > 2_048 {
		return encryptResponse{}, ErrGCPOperation
	}
	crc, err := parseCRC32C(wire.CiphertextCRC32C)
	if err != nil {
		return encryptResponse{}, ErrGCPOperation
	}
	return encryptResponse{
		Name: wire.Name, Ciphertext: wire.Ciphertext, CiphertextCRC32C: crc,
		VerifiedPlaintextCRC32C: wire.VerifiedPlaintextCRC32C,
		VerifiedAADCRC32C:       wire.VerifiedAADCRC32C,
	}, nil
}

type decryptResponse struct {
	Plaintext       string
	PlaintextCRC32C uint32
}

func decodeDecryptResponse(body []byte) (decryptResponse, error) {
	var wire struct {
		Plaintext       string `json:"plaintext"`
		PlaintextCRC32C string `json:"plaintextCrc32c"`
	}
	if decodeJSON(body, &wire) != nil {
		return decryptResponse{}, ErrGCPOperation
	}
	crc, err := parseCRC32C(wire.PlaintextCRC32C)
	if err != nil {
		return decryptResponse{}, ErrGCPOperation
	}
	return decryptResponse{Plaintext: wire.Plaintext, PlaintextCRC32C: crc}, nil
}

func decodeJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(target); err != nil {
		return ErrGCPOperation
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrGCPOperation
	}
	return nil
}

func parseCryptoKeyVersionResource(value string) (string, string, error) {
	if len(value) < 1 || len(value) > 2_048 {
		return "", "", ErrGCPConfiguration
	}
	match := cryptoKeyVersionPattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return "", "", ErrGCPConfiguration
	}
	return match[1], value, nil
}

func encodeBase64(value []byte) string { return base64.StdEncoding.EncodeToString(value) }

func decodeCanonicalBase64(value string, maximum int) ([]byte, error) {
	if len(value) < 4 || len(value) > maximum || len(value)%4 != 0 {
		return nil, ErrGCPOperation
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, ErrGCPOperation
	}
	return decoded, nil
}

func parseCRC32C(value string) (uint32, error) {
	if len(value) < 1 || len(value) > 10 || !unsignedDecimalPattern.MatchString(value) {
		return 0, ErrGCPOperation
	}
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil {
		return 0, ErrGCPOperation
	}
	return uint32(parsed), nil
}

func checksum(value []byte) uint32 { return crc32.Checksum(value, castagnoliTable) }
