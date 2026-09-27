package accountdeletioncredential

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDeriverProducesStableScopedCredentials(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	deriver, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	key[0] = 0
	scope := credentialTestScope(t, 101, 201)
	idempotency, _ := accountdeletion.ParseIdempotencyKey(strings.Repeat("A", 43))
	first, err := deriver.Derive(scope, idempotency)
	if err != nil {
		t.Fatal(err)
	}
	second, err := deriver.Derive(scope, idempotency)
	if err != nil || first != second {
		t.Fatalf("deterministic Derive() = %#v / %#v, %v", first, second, err)
	}
	pristine, err := New(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	want, err := pristine.Derive(scope, idempotency)
	if err != nil || first != want {
		t.Fatalf("caller key mutation changed derivation: %#v / %#v, %v", first, want, err)
	}
	if first.IdempotencyHash == first.SecretHash || string(first.Secret) == string(first.IdempotencyHash) {
		t.Fatalf("domains were not separated: %#v", first)
	}
	if digest, digestErr := deriver.DigestSecret(first.Secret); digestErr != nil || digest != first.SecretHash {
		t.Fatalf("DigestSecret() = %q, %v", digest, digestErr)
	}

	otherScope := credentialTestScope(t, 102, 202)
	other, err := deriver.Derive(otherScope, idempotency)
	if err != nil || other == first {
		t.Fatalf("scope-separated Derive() = %#v, %v", other, err)
	}
}

func TestDeriverRejectsInvalidInputs(t *testing.T) {
	if _, err := New(bytes.Repeat([]byte{1}, 31)); err == nil {
		t.Fatal("short key was accepted")
	}
	deriver, err := New(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deriver.Derive(accountdeletion.Scope{}, accountdeletion.IdempotencyKey("invalid")); err == nil {
		t.Fatal("invalid derivation input was accepted")
	}
	if _, err := deriver.DigestSecret(accountdeletion.ContinuationSecret("invalid")); err == nil {
		t.Fatal("invalid continuation secret was accepted")
	}
}

func credentialTestScope(t *testing.T, accountSuffix, vaultSuffix int) accountdeletion.Scope {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-" + leftPadCredentialID(accountSuffix))
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-" + leftPadCredentialID(vaultSuffix))
	if err != nil {
		t.Fatal(err)
	}
	return accountdeletion.Scope{AccountID: accountID, VaultID: vaultID}
}

func leftPadCredentialID(value int) string {
	return fmt.Sprintf("%012d", value)
}
