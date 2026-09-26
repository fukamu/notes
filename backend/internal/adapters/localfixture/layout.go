package localfixture

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	fixture "github.com/fukamu/notes/backend/internal/localfixture"
)

var ErrLayoutOperation = errors.New("local fixture directory operation failed")

type Layout struct {
	RootDirectory   string
	ObjectDirectory string
	NonceDirectory  string
	KeyDirectory    string
}

func PrepareLayout(root string) (Layout, error) {
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return Layout{}, err
	}
	if err := rejectUnexpectedEntries(clean); err != nil {
		return Layout{}, err
	}
	for _, name := range []string{
		fixture.ObjectDirectoryName,
		fixture.NonceDirectoryName,
		fixture.KeyDirectoryName,
	} {
		path := filepath.Join(clean, name)
		if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return Layout{}, ErrLayoutOperation
		}
		if _, err := validatePrivateDirectory(path); err != nil {
			return Layout{}, ErrLayoutOperation
		}
	}
	if err := syncDirectory(clean); err != nil {
		return Layout{}, err
	}
	return OpenLayout(clean)
}

func OpenLayout(root string) (Layout, error) {
	clean, err := validatePrivateDirectory(root)
	if err != nil {
		return Layout{}, err
	}
	if err := rejectUnexpectedEntries(clean); err != nil {
		return Layout{}, err
	}
	layout := Layout{
		RootDirectory:   clean,
		ObjectDirectory: filepath.Join(clean, fixture.ObjectDirectoryName),
		NonceDirectory:  filepath.Join(clean, fixture.NonceDirectoryName),
		KeyDirectory:    filepath.Join(clean, fixture.KeyDirectoryName),
	}
	for _, path := range []string{layout.ObjectDirectory, layout.NonceDirectory, layout.KeyDirectory} {
		if _, err := validatePrivateDirectory(path); err != nil {
			return Layout{}, ErrLayoutOperation
		}
	}
	return layout, nil
}

func validatePrivateDirectory(root string) (string, error) {
	if root == "" || strings.ContainsRune(root, '\x00') || !filepath.IsAbs(root) {
		return "", ErrLayoutOperation
	}
	clean := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || resolved != clean {
		return "", ErrLayoutOperation
	}
	info, err := os.Lstat(clean)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return "", ErrLayoutOperation
	}
	return clean, nil
}

func rejectUnexpectedEntries(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ErrLayoutOperation
	}
	allowed := map[string]struct{}{
		fixture.ObjectDirectoryName: {},
		fixture.NonceDirectoryName:  {},
		fixture.KeyDirectoryName:    {},
	}
	for _, entry := range entries {
		if _, ok := allowed[entry.Name()]; !ok || entry.Type()&os.ModeSymlink != 0 {
			return ErrLayoutOperation
		}
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return ErrLayoutOperation
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return ErrLayoutOperation
	}
	return nil
}
