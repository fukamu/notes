package runtimefoundation

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

// ScopedLaunchAdmission keeps the local fixture on the same server-side
// launch-admission boundary as production while preserving its exact,
// disposable owner scope.
type ScopedLaunchAdmission struct {
	context identity.VaultContext
	subject access.Subject
	gate    launchgate.Reader
}

func NewScopedLaunchAdmission(
	vaultContext identity.VaultContext,
	subject access.Subject,
	gate launchgate.Reader,
) (*ScopedLaunchAdmission, error) {
	if gate == nil || subject == "" {
		return nil, errors.New("launch admission scope is required")
	}
	return &ScopedLaunchAdmission{context: vaultContext, subject: subject, gate: gate}, nil
}

func (admission *ScopedLaunchAdmission) AuthorizeVault(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (launchgate.Decision, error) {
	if admission == nil || admission.gate == nil || vaultContext != admission.context {
		return launchgate.Decision{}, nil
	}
	subject := admission.subject
	return launchgate.Resolve(ctx, admission.gate, &subject)
}
