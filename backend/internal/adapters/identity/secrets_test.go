package identityadapter

import (
	"bytes"
	"context"
	"testing"
	"time"

	otpadapter "github.com/fukamu/notes/backend/internal/adapters/otp"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestSignupIdentifiersGenerateTypedValues(t *testing.T) {
	secrets, err := otpadapter.NewSecrets(
		bytes.NewReader(bytes.Repeat([]byte{0x5a}, 82)),
		func() time.Time { return time.UnixMilli(1_700_000_000_123) },
	)
	if err != nil {
		t.Fatal(err)
	}
	identifiers, err := NewSignupIdentifiers(secrets)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	accountID, _ := identifiers.CreateAccountID(ctx)
	vaultID, _ := identifiers.CreateVaultID(ctx)
	identityID, _ := identifiers.CreateIdentityID(ctx)
	sessionID, _ := identifiers.CreateSessionID(ctx)
	consentID, _ := identifiers.CreateTermsConsentID(ctx)
	token, _ := identifiers.CreateSessionToken(ctx)
	for name, check := range map[string]func() error{
		"account":  func() error { _, err := identity.ParseAccountID(accountID); return err },
		"vault":    func() error { _, err := identity.ParseVaultID(vaultID); return err },
		"identity": func() error { _, err := identity.ParseIdentityID(identityID); return err },
		"session":  func() error { _, err := identity.ParseSessionID(sessionID); return err },
		"consent":  func() error { _, err := identity.ParseIdentityID(consentID); return err },
		"token":    func() error { _, err := identity.ParseSessionToken(token); return err },
	} {
		if err := check(); err != nil {
			t.Errorf("%s value rejected: %v", name, err)
		}
	}
}
