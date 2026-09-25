package objectstorage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

var ErrDirectoryOperation = errors.New("local private object directory operation failed")

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

func (directory *Directory) Get(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) ([]byte, bool, error) {
	path, err := directory.objectPath(ctx, objectKey)
	if err != nil {
		return nil, false, err
	}
	value, found, err := readPrivateObject(path)
	if err != nil {
		return nil, false, ErrDirectoryOperation
	}
	return value, found, nil
}

func (directory *Directory) PutIfAbsent(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
	value []byte,
	createdAtMilli int64,
) (encryptedobject.PutResult, error) {
	path, err := directory.objectPath(ctx, objectKey)
	if err != nil {
		return "", err
	}
	if createdAtMilli < 0 || createdAtMilli > 9_007_199_254_740_991 ||
		len(value) > int(encryptedobject.MaximumStoredBytes) {
		return "", ErrDirectoryOperation
	}
	temporary, err := os.CreateTemp(directory.root, ".put-")
	if err != nil {
		return "", ErrDirectoryOperation
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", ErrDirectoryOperation
	}
	working := append([]byte(nil), value...)
	defer clear(working)
	if _, err := temporary.Write(working); err != nil {
		_ = temporary.Close()
		return "", ErrDirectoryOperation
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return "", ErrDirectoryOperation
	}
	if err := temporary.Close(); err != nil {
		return "", ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.Link(temporaryPath, path); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return "", ErrDirectoryOperation
		}
		existing, found, readErr := readPrivateObject(path)
		if readErr != nil || !found {
			return "", ErrDirectoryOperation
		}
		defer clear(existing)
		if bytes.Equal(existing, value) {
			return encryptedobject.PutAlreadyPresent, nil
		}
		return encryptedobject.PutConflict, nil
	}
	createdAt := time.UnixMilli(createdAtMilli)
	if err := os.Chtimes(path, createdAt, createdAt); err != nil || syncPrivateDirectory(directory.root) != nil {
		return "", ErrDirectoryOperation
	}
	return encryptedobject.PutStored, nil
}

func (directory *Directory) Delete(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	path, err := directory.objectPath(ctx, objectKey)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return encryptedobject.DeleteNotFound, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return "", ErrDirectoryOperation
	}
	if err := os.Remove(path); err != nil || syncPrivateDirectory(directory.root) != nil {
		return "", ErrDirectoryOperation
	}
	return encryptedobject.DeleteDeleted, nil
}

func (directory *Directory) List(ctx context.Context) ([]encryptedobject.PrivateObjectDescriptor, error) {
	if directory == nil || directory.root == "" || ctx == nil {
		return nil, ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory.root)
	if err != nil {
		return nil, ErrDirectoryOperation
	}
	result := make([]encryptedobject.PrivateObjectDescriptor, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if strings.HasPrefix(entry.Name(), ".put-") {
			continue
		}
		objectKey, parseErr := encryptedobject.ParseObjectKey(entry.Name())
		if parseErr != nil || entry.Type()&os.ModeSymlink != 0 {
			return nil, ErrDirectoryOperation
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
			return nil, ErrDirectoryOperation
		}
		createdAt := info.ModTime().UnixMilli()
		if createdAt < 0 || createdAt > 9_007_199_254_740_991 {
			return nil, ErrDirectoryOperation
		}
		result = append(result, encryptedobject.PrivateObjectDescriptor{
			ObjectKey: objectKey, CreatedAtMilli: createdAt,
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ObjectKey < result[right].ObjectKey })
	return result, nil
}

func (directory *Directory) objectPath(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) (string, error) {
	if directory == nil || directory.root == "" || ctx == nil {
		return "", ErrDirectoryOperation
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
		return "", ErrDirectoryOperation
	}
	return filepath.Join(directory.root, string(objectKey)), nil
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

func readPrivateObject(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
		info.Size() < 0 || info.Size() > encryptedobject.MaximumStoredBytes {
		return nil, false, ErrDirectoryOperation
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false, ErrDirectoryOperation
	}
	defer file.Close()
	value, err := io.ReadAll(io.LimitReader(file, encryptedobject.MaximumStoredBytes+1))
	if err != nil || int64(len(value)) > encryptedobject.MaximumStoredBytes {
		clear(value)
		return nil, false, ErrDirectoryOperation
	}
	return value, true, nil
}

func syncPrivateDirectory(root string) error {
	directory, err := os.Open(root)
	if err != nil {
		return ErrDirectoryOperation
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return ErrDirectoryOperation
	}
	return nil
}
