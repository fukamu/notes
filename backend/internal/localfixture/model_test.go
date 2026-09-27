package localfixture_test

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/localfixture"
)

func TestNewSeedProducesDeterministicValidatedStateWithoutRawToken(t *testing.T) {
	t.Parallel()
	allowed, _ := access.ParseSubject("fixture-owner")
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	rawToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32))
	token, _ := identity.ParseSessionToken(rawToken)
	metadata := cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: 1, KEKReference: "local-fixture://key/1",
		WrappedDEK:     base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x52}, 32)),
		CreatedAtMilli: localfixture.FixtureTimestamp,
	}
	first, err := localfixture.NewSeed(allowed, accountID, vaultID, sessionID, epoch, token, metadata)
	if err != nil {
		t.Fatalf("NewSeed() error = %v", err)
	}
	second, err := localfixture.NewSeed(allowed, accountID, vaultID, sessionID, epoch, token, metadata)
	if err != nil {
		t.Fatalf("NewSeed() second error = %v", err)
	}
	if !localfixture.ValidSeed(first) || !localfixture.ValidSeed(second) || first.TokenHash != second.TokenHash ||
		first.Context != second.Context || first.Session != second.Session || first.DEK != second.DEK {
		t.Fatalf("fixture seeds differ: %#v %#v", first, second)
	}
	if string(first.TokenHash) == rawToken {
		t.Fatal("fixture seed retained the raw session token as its hash")
	}
	if first.Subscription.AccountID != accountID || first.Subscription.VaultID != vaultID ||
		first.Entitlement.SourceSubscriptionID != first.Subscription.SubscriptionID ||
		first.Entitlement.State.ValidUntil != identity.MaximumSafeInteger {
		t.Fatalf("fixture business state = %#v %#v", first.Subscription, first.Entitlement)
	}
}

func TestValidSeedRejectsCrossScopeAndInvalidFixtureState(t *testing.T) {
	t.Parallel()
	seed := validSeed(t)
	seed.Session.VaultID = identity.VaultID("01999c20-9e33-7000-8000-000000000099")
	if localfixture.ValidSeed(seed) {
		t.Fatal("ValidSeed accepted a cross-scope session")
	}
	seed = validSeed(t)
	seed.DEK.CreatedAtMilli = 2
	if _, err := localfixture.NewSeed(
		seed.AllowedSubject,
		seed.Context.AccountID,
		seed.Context.VaultID,
		seed.Context.SessionID,
		seed.Context.SessionEpoch,
		identity.SessionToken("invalid"),
		seed.DEK,
	); err == nil {
		t.Fatal("NewSeed accepted invalid token and DEK fixture time")
	}
}

func TestValidateDatabaseURLAllowsOnlyTheExactDisposableTarget(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "localhost", value: "postgres://notes:secret@localhost:5432/fukamu_notes_go_test"},
		{name: "ipv4", value: "postgresql://notes:secret@127.0.0.1/fukamu_notes_go_test?sslmode=disable"},
		{name: "ipv6", value: "postgres://notes:secret@[::1]:5432/fukamu_notes_go_test"},
		{name: "remote", value: "postgres://notes:secret@db.example/fukamu_notes_go_test", wantErr: true},
		{name: "wrong database", value: "postgres://notes:secret@localhost/notes", wantErr: true},
		{name: "host override", value: "postgres://notes:secret@localhost/fukamu_notes_go_test?hostaddr=203.0.113.1", wantErr: true},
		{name: "duplicate sslmode", value: "postgres://notes:secret@localhost/fukamu_notes_go_test?sslmode=disable&sslmode=require", wantErr: true},
		{name: "fragment", value: "postgres://notes:secret@localhost/fukamu_notes_go_test#sensitive", wantErr: true},
		{name: "wrong scheme", value: "mysql://notes:secret@localhost/fukamu_notes_go_test", wantErr: true},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := localfixture.ValidateDatabaseURL(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("ValidateDatabaseURL() error = %v", err)
			}
			if err != nil && bytes.Contains([]byte(err.Error()), []byte("secret")) {
				t.Fatal("database validation error disclosed credentials")
			}
		})
	}
}

func validSeed(t *testing.T) localfixture.Seed {
	t.Helper()
	allowed, _ := access.ParseSubject("fixture-owner")
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	token, _ := identity.ParseSessionToken(base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32)))
	seed, err := localfixture.NewSeed(
		allowed,
		accountID,
		vaultID,
		sessionID,
		epoch,
		token,
		cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1, KEKReference: "local-fixture://key/1",
			WrappedDEK:     base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x52}, 32)),
			CreatedAtMilli: localfixture.FixtureTimestamp,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return seed
}
