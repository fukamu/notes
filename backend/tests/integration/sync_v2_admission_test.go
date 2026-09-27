//go:build integration

package integration_test

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

type allowVaultAdmission struct{}

func (allowVaultAdmission) AuthorizeVault(
	context.Context,
	identity.VaultContext,
) (launchgate.Decision, error) {
	return launchgate.Decision{UserAllowed: true, CanAccess: true}, nil
}
