package recoverykey

import (
	"bytes"
	"context"
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
