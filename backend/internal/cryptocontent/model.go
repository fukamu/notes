package cryptocontent

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	EnvelopeCryptoVersion = "fukamu-envelope-aes-256-gcm/v1"
	EnvelopeAlgorithm     = "A256GCM"
	EnvelopeAADVersion    = "fukamu-envelope-aad/v1"
	WrappedDEKAADVersion  = "fukamu-vault-dek-wrap/v1"
	MaximumDEKVersion     = int64(2_147_483_647)
	MaximumSafeInteger    = int64(9_007_199_254_740_991)
	MaximumKeyringSize    = 64
	MaximumWrappedDEKSize = 16_384
)

var (
	ErrInvalidEnvelope   = errors.New("invalid envelope cryptographic value")
	ErrEnvelopePolicy    = errors.New("envelope operation rejected")
	ErrUnknownDEKVersion = errors.New("unknown data-encryption key version")
	ErrVaultMismatch     = errors.New("vault does not match keyring")
	uuidV7Pattern        = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	base64URLPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

type DEKVersion int64
type ObjectRevision int64
type ObjectKind string

const (
	ObjectCard     ObjectKind = "card"
	ObjectConflict ObjectKind = "conflict"
)

type ObjectContext struct {
	VaultID        identity.VaultID
	Kind           ObjectKind
	ObjectID       string
	ObjectRevision ObjectRevision
}

type VaultDEKMetadata struct {
	VaultID        identity.VaultID `json:"vaultId"`
	DEKVersion     DEKVersion       `json:"dekVersion"`
	KEKReference   string           `json:"kekKeyReference"`
	WrappedDEK     string           `json:"wrappedDek"`
	CreatedAtMilli int64            `json:"createdAt"`
}

type VaultDEKKeyring struct {
	VaultID      identity.VaultID
	WriteVersion DEKVersion
	Versions     []VaultDEKMetadata
}

type EnvelopeCiphertext struct {
	Format        string     `json:"format"`
	Algorithm     string     `json:"algorithm"`
	DEKVersion    DEKVersion `json:"dekVersion"`
	Nonce         string     `json:"nonce"`
	SealedPayload string     `json:"sealedPayload"`
}

func ParseDEKVersion(value int64) (DEKVersion, error) {
	if value < 1 || value > MaximumDEKVersion {
		return 0, ErrInvalidEnvelope
	}
	return DEKVersion(value), nil
}

func ParseObjectRevision(value int64) (ObjectRevision, error) {
	if value < 1 || value > MaximumDEKVersion {
		return 0, ErrInvalidEnvelope
	}
	return ObjectRevision(value), nil
}

func ValidateObjectContext(value ObjectContext) error {
	if _, err := identity.ParseVaultID(string(value.VaultID)); err != nil {
		return ErrInvalidEnvelope
	}
	if value.Kind != ObjectCard && value.Kind != ObjectConflict {
		return ErrInvalidEnvelope
	}
	if !uuidV7Pattern.MatchString(value.ObjectID) {
		return ErrInvalidEnvelope
	}
	if _, err := ParseObjectRevision(int64(value.ObjectRevision)); err != nil {
		return ErrInvalidEnvelope
	}
	return nil
}

func ValidateVaultDEKMetadata(value VaultDEKMetadata) error {
	if _, err := identity.ParseVaultID(string(value.VaultID)); err != nil {
		return ErrInvalidEnvelope
	}
	if _, err := ParseDEKVersion(int64(value.DEKVersion)); err != nil {
		return ErrInvalidEnvelope
	}
	if len(value.KEKReference) < 1 || len(value.KEKReference) > 2_048 {
		return ErrInvalidEnvelope
	}
	if _, err := DecodeCanonicalBase64URL(value.WrappedDEK, 1, MaximumWrappedDEKSize); err != nil {
		return ErrInvalidEnvelope
	}
	if value.CreatedAtMilli < 0 || value.CreatedAtMilli > MaximumSafeInteger {
		return ErrInvalidEnvelope
	}
	return nil
}

func NewVaultDEKKeyring(
	vaultID identity.VaultID,
	writeVersion DEKVersion,
	versions []VaultDEKMetadata,
) (VaultDEKKeyring, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil ||
		len(versions) < 1 || len(versions) > MaximumKeyringSize {
		return VaultDEKKeyring{}, ErrInvalidEnvelope
	}
	if _, err := ParseDEKVersion(int64(writeVersion)); err != nil {
		return VaultDEKKeyring{}, ErrInvalidEnvelope
	}
	seen := make(map[DEKVersion]struct{}, len(versions))
	foundWriteVersion := false
	copyOfVersions := make([]VaultDEKMetadata, len(versions))
	for index, metadata := range versions {
		if ValidateVaultDEKMetadata(metadata) != nil || metadata.VaultID != vaultID {
			return VaultDEKKeyring{}, ErrInvalidEnvelope
		}
		if _, duplicate := seen[metadata.DEKVersion]; duplicate {
			return VaultDEKKeyring{}, ErrInvalidEnvelope
		}
		seen[metadata.DEKVersion] = struct{}{}
		foundWriteVersion = foundWriteVersion || metadata.DEKVersion == writeVersion
		copyOfVersions[index] = metadata
	}
	if !foundWriteVersion {
		return VaultDEKKeyring{}, ErrInvalidEnvelope
	}
	return VaultDEKKeyring{
		VaultID: vaultID, WriteVersion: writeVersion, Versions: copyOfVersions,
	}, nil
}

func (keyring VaultDEKKeyring) SelectForWrite(vaultID identity.VaultID) (VaultDEKMetadata, error) {
	return keyring.selectVersion(vaultID, keyring.WriteVersion)
}

func (keyring VaultDEKKeyring) SelectForRead(
	vaultID identity.VaultID,
	version DEKVersion,
) (VaultDEKMetadata, error) {
	return keyring.selectVersion(vaultID, version)
}

func (keyring VaultDEKKeyring) selectVersion(
	vaultID identity.VaultID,
	version DEKVersion,
) (VaultDEKMetadata, error) {
	validated, err := NewVaultDEKKeyring(
		keyring.VaultID,
		keyring.WriteVersion,
		keyring.Versions,
	)
	if err != nil {
		return VaultDEKMetadata{}, ErrInvalidEnvelope
	}
	if keyring.VaultID != vaultID {
		return VaultDEKMetadata{}, ErrVaultMismatch
	}
	for _, metadata := range validated.Versions {
		if metadata.DEKVersion == version {
			return metadata, nil
		}
	}
	return VaultDEKMetadata{}, ErrUnknownDEKVersion
}

func SerializeEnvelopeAAD(context ObjectContext, version DEKVersion) (string, error) {
	if ValidateObjectContext(context) != nil {
		return "", ErrInvalidEnvelope
	}
	if _, err := ParseDEKVersion(int64(version)); err != nil {
		return "", ErrInvalidEnvelope
	}
	encoded, err := json.Marshal([]any{
		EnvelopeAADVersion,
		string(context.VaultID),
		string(context.Kind),
		context.ObjectID,
		int64(context.ObjectRevision),
		EnvelopeCryptoVersion,
		int64(version),
	})
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	return string(encoded), nil
}

func SerializeWrappedDEKAAD(
	vaultID identity.VaultID,
	version DEKVersion,
	keyReference string,
) (string, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return "", ErrInvalidEnvelope
	}
	if _, err := ParseDEKVersion(int64(version)); err != nil ||
		len(keyReference) < 1 || len(keyReference) > 2_048 {
		return "", ErrInvalidEnvelope
	}
	encoded, err := json.Marshal([]any{
		WrappedDEKAADVersion,
		string(vaultID),
		int64(version),
		keyReference,
	})
	if err != nil {
		return "", ErrInvalidEnvelope
	}
	return string(encoded), nil
}

func DecodeEnvelopeCiphertext(encoded []byte) (EnvelopeCiphertext, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var value EnvelopeCiphertext
	if err := decoder.Decode(&value); err != nil {
		return EnvelopeCiphertext{}, ErrInvalidEnvelope
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return EnvelopeCiphertext{}, ErrInvalidEnvelope
	}
	if ValidateEnvelopeCiphertext(value) != nil {
		return EnvelopeCiphertext{}, ErrInvalidEnvelope
	}
	return value, nil
}

func ValidateEnvelopeCiphertext(value EnvelopeCiphertext) error {
	if value.Format != EnvelopeCryptoVersion || value.Algorithm != EnvelopeAlgorithm {
		return ErrInvalidEnvelope
	}
	if _, err := ParseDEKVersion(int64(value.DEKVersion)); err != nil {
		return ErrInvalidEnvelope
	}
	if decoded, err := DecodeCanonicalBase64URL(value.Nonce, 16, 16); err != nil || len(decoded) != 12 {
		return ErrInvalidEnvelope
	}
	if _, err := DecodeCanonicalBase64URL(value.SealedPayload, 22, MaximumWrappedDEKSize); err != nil {
		return ErrInvalidEnvelope
	}
	return nil
}

func EncodeBase64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func DecodeCanonicalBase64URL(value string, minimum, maximum int) ([]byte, error) {
	if len(value) < minimum || len(value) > maximum || !base64URLPattern.MatchString(value) {
		return nil, ErrInvalidEnvelope
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, ErrInvalidEnvelope
	}
	return decoded, nil
}
