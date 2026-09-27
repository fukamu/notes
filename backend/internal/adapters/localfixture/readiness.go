package localfixture

import (
	"context"
	"errors"

	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrNotReady = errors.New("local fixture directories are not ready")

type Readiness struct {
	root    string
	vaultID identity.VaultID
}

func NewReadiness(root string, vaultID identity.VaultID) (*Readiness, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return nil, ErrNotReady
	}
	if _, err := OpenLayout(root); err != nil {
		return nil, ErrNotReady
	}
	return &Readiness{root: root, vaultID: vaultID}, nil
}

func (readiness *Readiness) Check(ctx context.Context) error {
	if readiness == nil || ctx == nil {
		return ErrNotReady
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	layout, err := OpenLayout(readiness.root)
	if err != nil {
		return ErrNotReady
	}
	metadata, err := recoverykeyadapter.LoadFixtureMetadata(layout.KeyDirectory, readiness.vaultID)
	if err != nil {
		return ErrNotReady
	}
	keys, err := recoverykeyadapter.NewDirectory(layout.KeyDirectory, readiness.vaultID)
	if err != nil {
		return ErrNotReady
	}
	key, err := keys.UnwrapDataKey(ctx, metadata)
	if err != nil {
		return ErrNotReady
	}
	key.Destroy()
	return nil
}
