package contentcrypto

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrDirectoryNonceReservation = errors.New("local nonce reservation operation failed")

type DirectoryNonceReservations struct {
	root string
}

func NewDirectoryNonceReservations(root string) (*DirectoryNonceReservations, error) {
	if root == "" || strings.ContainsRune(root, '\x00') || !filepath.IsAbs(root) {
		return nil, ErrDirectoryNonceReservation
	}
	clean := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || resolved != clean {
		return nil, ErrDirectoryNonceReservation
	}
	info, err := os.Lstat(clean)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return nil, ErrDirectoryNonceReservation
	}
	return &DirectoryNonceReservations{root: clean}, nil
}

func (reservations *DirectoryNonceReservations) ReserveNonce(
	ctx context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
	nonce string,
) (bool, error) {
	if reservations == nil || reservations.root == "" || ctx == nil {
		return false, ErrDirectoryNonceReservation
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return false, ErrDirectoryNonceReservation
	}
	if _, err := cryptocontent.ParseDEKVersion(int64(version)); err != nil {
		return false, ErrDirectoryNonceReservation
	}
	decoded, err := cryptocontent.DecodeCanonicalBase64URL(nonce, 16, 16)
	if err != nil || len(decoded) != 12 {
		clear(decoded)
		return false, ErrDirectoryNonceReservation
	}
	clear(decoded)
	digest := sha256.Sum256([]byte(
		"fukamu-local-nonce-reservation/v1\x00" + string(vaultID) + "\x00" +
			strconv.FormatInt(int64(version), 10) + "\x00" + nonce,
	))
	path := filepath.Join(reservations.root, "nonce_v1_"+hex.EncodeToString(digest[:]))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, ErrDirectoryNonceReservation
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return false, ErrDirectoryNonceReservation
	}
	if err := file.Close(); err != nil {
		return false, ErrDirectoryNonceReservation
	}
	directory, err := os.Open(reservations.root)
	if err != nil {
		return false, ErrDirectoryNonceReservation
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return false, ErrDirectoryNonceReservation
	}
	return true, nil
}
