package recoverybackup

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

const maximumManifestBytes = int64(32 * 1024 * 1024)

var ErrDirectoryOperation = errors.New("local recovery backup directory operation failed")

// Directory is a read-only adapter for an isolated local recovery fixture. The
// root contains manifest.json and one private directory per backup ID. It does
// not model a production backup provider.
type Directory struct {
	root string
}

func NewDirectory(root string) (*Directory, error) {
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return nil, err
	}
	return &Directory{root: clean}, nil
}

func (directory *Directory) LoadManifest(
	ctx context.Context,
	scope encryptedobject.RecoveryScope,
) ([]byte, error) {
	if directory == nil || directory.root == "" || ctx == nil ||
		encryptedobject.ValidateRecoveryScope(scope) != nil {
		return nil, ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return readPrivateFile(filepath.Join(directory.root, "manifest.json"), maximumManifestBytes)
}

func (directory *Directory) LoadCiphertext(
	ctx context.Context,
	backupID encryptedobject.RecoveryBackupID,
	objectKey encryptedobject.ObjectKey,
) ([]byte, bool, error) {
	if directory == nil || directory.root == "" || ctx == nil {
		return nil, false, ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if _, err := encryptedobject.ParseRecoveryBackupID(string(backupID)); err != nil {
		return nil, false, ErrDirectoryOperation
	}
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
		return nil, false, ErrDirectoryOperation
	}
	backupRoot, err := validatePrivateDirectory(filepath.Join(directory.root, string(backupID)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil || filepath.Dir(backupRoot) != directory.root {
		return nil, false, ErrDirectoryOperation
	}
	value, err := readPrivateFile(filepath.Join(backupRoot, string(objectKey)), encryptedobject.MaximumStoredBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, ErrDirectoryOperation
	}
	return value, true, nil
}

func validatePrivateDirectory(root string) (string, error) {
	if root == "" || strings.ContainsRune(root, '\x00') || !filepath.IsAbs(root) {
		return "", ErrDirectoryOperation
	}
	clean := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(clean)
	if errors.Is(err, os.ErrNotExist) {
		return "", os.ErrNotExist
	}
	if err != nil || resolved != clean {
		return "", ErrDirectoryOperation
	}
	info, err := os.Lstat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return "", os.ErrNotExist
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", ErrDirectoryOperation
	}
	return clean, nil
}

func readPrivateFile(path string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, os.ErrNotExist
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 || info.Size() < 1 || info.Size() > maximum {
		return nil, ErrDirectoryOperation
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrDirectoryOperation
	}
	defer file.Close()
	value, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil || int64(len(value)) > maximum {
		clear(value)
		return nil, ErrDirectoryOperation
	}
	return value, nil
}
