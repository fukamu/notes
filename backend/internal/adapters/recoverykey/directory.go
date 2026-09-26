package recoverykey

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	FixtureKeyFormat    = "fukamu-local-recovery-key/v1"
	maximumKeyFileBytes = int64(32 * 1024)
)

var ErrDirectoryOperation = errors.New("local recovery key directory operation failed")

type Directory struct {
	root    string
	vaultID identity.VaultID
}

type keyFile struct {
	Format       string `json:"format"`
	VaultID      string `json:"vaultId"`
	DEKVersion   int64  `json:"dekVersion"`
	KEKReference string `json:"kekKeyReference"`
	WrappedDEK   string `json:"wrappedDek"`
	RawDEK       string `json:"rawDek"`
}

func NewDirectory(root string, vaultID identity.VaultID) (*Directory, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return nil, ErrDirectoryOperation
	}
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return nil, err
	}
	return &Directory{root: clean, vaultID: vaultID}, nil
}

func PrepareFixtureKey(
	root string,
	vaultID identity.VaultID,
) (cryptocontent.VaultDEKMetadata, error) {
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	path := filepath.Join(clean, "dek-1.json")
	if _, err := os.Lstat(path); err == nil {
		return LoadFixtureMetadata(clean, vaultID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		clear(raw)
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	defer clear(raw)
	metadata := fixtureMetadata(vaultID, raw)
	wire := keyFile{
		Format: FixtureKeyFormat, VaultID: string(vaultID), DEKVersion: 1,
		KEKReference: metadata.KEKReference, WrappedDEK: metadata.WrappedDEK,
		RawDEK: base64.RawURLEncoding.EncodeToString(raw),
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	defer clear(encoded)
	temporary, err := os.CreateTemp(clean, ".fixture-key-")
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	written, writeErr := temporary.Write(encoded)
	if writeErr != nil || written != len(encoded) || temporary.Sync() != nil || temporary.Close() != nil {
		_ = temporary.Close()
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	if err := os.Link(temporaryPath, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return LoadFixtureMetadata(clean, vaultID)
		}
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	if syncPrivateDirectory(clean) != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	return LoadFixtureMetadata(clean, vaultID)
}

func LoadFixtureMetadata(
	root string,
	vaultID identity.VaultID,
) (cryptocontent.VaultDEKMetadata, error) {
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	encoded, err := readPrivateFile(filepath.Join(clean, "dek-1.json"))
	if err != nil {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	defer clear(encoded)
	wire, err := decodeKeyFile(encoded)
	if err != nil || wire.Format != FixtureKeyFormat || wire.VaultID != string(vaultID) || wire.DEKVersion != 1 {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	raw, err := cryptocontent.DecodeCanonicalBase64URL(wire.RawDEK, 43, 43)
	if err != nil || len(raw) != 32 {
		clear(raw)
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	defer clear(raw)
	expected := fixtureMetadata(vaultID, raw)
	if subtle.ConstantTimeCompare([]byte(wire.KEKReference), []byte(expected.KEKReference)) != 1 ||
		subtle.ConstantTimeCompare([]byte(wire.WrappedDEK), []byte(expected.WrappedDEK)) != 1 {
		return cryptocontent.VaultDEKMetadata{}, ErrDirectoryOperation
	}
	return expected, nil
}

func fixtureMetadata(vaultID identity.VaultID, raw []byte) cryptocontent.VaultDEKMetadata {
	digest := sha256.New()
	_, _ = digest.Write([]byte("fukamu-local-fixture-wrapped-dek/v1\x00"))
	_, _ = digest.Write([]byte(vaultID))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write(raw)
	wrapped := base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: 1,
		KEKReference: "local-fixture://" + string(vaultID) + "/dek/1",
		WrappedDEK:   wrapped, CreatedAtMilli: 1,
	}
}

func (*Directory) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.VaultDEKMetadata{}, nil, ErrDirectoryOperation
}

func (directory *Directory) UnwrapDataKey(
	ctx context.Context,
	metadata cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	if directory == nil || directory.root == "" || ctx == nil ||
		cryptocontent.ValidateVaultDEKMetadata(metadata) != nil || metadata.VaultID != directory.vaultID {
		return nil, ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path := filepath.Join(directory.root, fmt.Sprintf("dek-%d.json", metadata.DEKVersion))
	encoded, err := readPrivateFile(path)
	if err != nil {
		return nil, ErrDirectoryOperation
	}
	defer clear(encoded)
	wire, err := decodeKeyFile(encoded)
	if err != nil || wire.Format != FixtureKeyFormat || wire.VaultID != string(metadata.VaultID) ||
		wire.DEKVersion != int64(metadata.DEKVersion) || wire.KEKReference != metadata.KEKReference ||
		wire.WrappedDEK != metadata.WrappedDEK {
		return nil, ErrDirectoryOperation
	}
	raw, err := cryptocontent.DecodeCanonicalBase64URL(wire.RawDEK, 43, 43)
	if err != nil || len(raw) != 32 {
		clear(raw)
		return nil, ErrDirectoryOperation
	}
	defer clear(raw)
	key, err := cryptocontent.NewDataEncryptionKey(raw)
	if err != nil {
		return nil, ErrDirectoryOperation
	}
	return key, nil
}

func decodeKeyFile(source []byte) (keyFile, error) {
	if hasDuplicateOrUnexpectedMembers(source) {
		return keyFile{}, ErrDirectoryOperation
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	var wire keyFile
	if err := decoder.Decode(&wire); err != nil {
		return keyFile{}, ErrDirectoryOperation
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return keyFile{}, ErrDirectoryOperation
	}
	return wire, nil
}

func hasDuplicateOrUnexpectedMembers(source []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(source))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return true
	}
	allowed := map[string]struct{}{
		"format": {}, "vaultId": {}, "dekVersion": {}, "kekKeyReference": {},
		"wrappedDek": {}, "rawDek": {},
	}
	seen := make(map[string]struct{}, len(allowed))
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return true
		}
		if _, accepted := allowed[name]; !accepted {
			return true
		}
		if _, duplicate := seen[name]; duplicate {
			return true
		}
		seen[name] = struct{}{}
		var ignored json.RawMessage
		if decoder.Decode(&ignored) != nil {
			return true
		}
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') || len(seen) != len(allowed) {
		return true
	}
	return decoder.Decode(&struct{}{}) != io.EOF
}

func validatePrivateDirectory(root string) (string, error) {
	if root == "" || strings.ContainsRune(root, '\x00') || !filepath.IsAbs(root) {
		return "", ErrDirectoryOperation
	}
	clean := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || resolved != clean {
		return "", ErrDirectoryOperation
	}
	info, err := os.Lstat(clean)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", ErrDirectoryOperation
	}
	return clean, nil
}

func readPrivateFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 || info.Size() < 1 || info.Size() > maximumKeyFileBytes {
		return nil, ErrDirectoryOperation
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrDirectoryOperation
	}
	defer file.Close()
	value, err := io.ReadAll(io.LimitReader(file, maximumKeyFileBytes+1))
	if err != nil || int64(len(value)) > maximumKeyFileBytes {
		clear(value)
		return nil, ErrDirectoryOperation
	}
	return value, nil
}

func syncPrivateDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return ErrDirectoryOperation
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return ErrDirectoryOperation
	}
	return nil
}
