package identityadapter

import (
	"context"
	"errors"

	otpadapter "github.com/fukamu/notes/backend/internal/adapters/otp"
	"github.com/fukamu/notes/backend/internal/identity"
)

var _ identity.SignupIdentifierPort = (*SignupIdentifiers)(nil)

type SignupIdentifiers struct {
	secrets *otpadapter.Secrets
}

func NewSignupIdentifiers(secrets *otpadapter.Secrets) (*SignupIdentifiers, error) {
	if secrets == nil {
		return nil, errors.New("signup entropy source is required")
	}
	return &SignupIdentifiers{secrets: secrets}, nil
}

func NewProductionSignupIdentifiers() *SignupIdentifiers {
	return &SignupIdentifiers{secrets: otpadapter.NewProductionSecrets()}
}

func (identifiers *SignupIdentifiers) CreateAccountID(ctx context.Context) (string, error) {
	return identifiers.createID(ctx)
}

func (identifiers *SignupIdentifiers) CreateVaultID(ctx context.Context) (string, error) {
	return identifiers.createID(ctx)
}

func (identifiers *SignupIdentifiers) CreateIdentityID(ctx context.Context) (string, error) {
	return identifiers.createID(ctx)
}

func (identifiers *SignupIdentifiers) CreateSessionID(ctx context.Context) (string, error) {
	return identifiers.createID(ctx)
}

func (identifiers *SignupIdentifiers) CreateTermsConsentID(ctx context.Context) (string, error) {
	return identifiers.createID(ctx)
}

func (identifiers *SignupIdentifiers) CreateSessionToken(ctx context.Context) (string, error) {
	if identifiers == nil || identifiers.secrets == nil {
		return "", errors.New("signup entropy source is unavailable")
	}
	return identifiers.secrets.CreateSalt(ctx)
}

func (identifiers *SignupIdentifiers) createID(ctx context.Context) (string, error) {
	if identifiers == nil || identifiers.secrets == nil {
		return "", errors.New("signup entropy source is unavailable")
	}
	return identifiers.secrets.CreateChallengeID(ctx)
}
