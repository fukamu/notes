package access_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	accesscore "github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
)

func TestLocalAssertionRoundTripAndFailures(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := accesscore.ParseSubject("opaque-owner")
	now := time.Unix(1_800_000_000, 0)
	valid, err := accessadapter.SignLocalAssertion(
		privateKey,
		"https://issuer.test",
		"notes-local",
		owner,
		now.Add(-time.Minute),
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := verifier.Verify(valid, now)
	if err != nil || got != owner {
		t.Fatalf("Verify() = %q, %v", got, err)
	}

	wrongIssuer, _ := accessadapter.NewLocalVerifier(publicKey, "https://other.test", "notes-local")
	wrongAudience, _ := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "other")
	_, otherPrivateKey, _ := ed25519.GenerateKey(nil)
	wrongSignature, _ := accessadapter.SignLocalAssertion(
		otherPrivateKey,
		"https://issuer.test",
		"notes-local",
		owner,
		now.Add(-time.Minute),
		now.Add(time.Minute),
	)
	expired, _ := accessadapter.SignLocalAssertion(
		privateKey,
		"https://issuer.test",
		"notes-local",
		owner,
		now.Add(-2*time.Minute),
		now.Add(-time.Minute),
	)
	for name, candidate := range map[string]string{
		"empty":           "",
		"wrong shape":     "a.b",
		"padded":          valid + "=",
		"wrong signature": wrongSignature,
		"expired":         expired,
	} {
		name, candidate := name, candidate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := verifier.Verify(candidate, now); !errors.Is(err, accessadapter.ErrInvalidAssertion) {
				t.Fatalf("Verify() error = %v", err)
			}
		})
	}
	if _, err := wrongIssuer.Verify(valid, now); !errors.Is(err, accessadapter.ErrInvalidAssertion) {
		t.Fatalf("wrong issuer error = %v", err)
	}
	if _, err := wrongAudience.Verify(valid, now); !errors.Is(err, accessadapter.ErrInvalidAssertion) {
		t.Fatalf("wrong audience error = %v", err)
	}
	if strings.Contains(accessadapter.ErrInvalidAssertion.Error(), string(owner)) {
		t.Fatal("fixed error disclosed the subject")
	}
}

func TestLocalAssertionRejectsDuplicateAndUnknownClaims(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, _ := ed25519.GenerateKey(nil)
	verifier, _ := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	now := time.Unix(1_800_000_000, 0)
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT"})
	claims := []string{
		`{"iss":"https://issuer.test","aud":"notes-local","sub":"owner","iat":1799999999,"exp":1800000060,"sub":"attacker"}`,
		`{"iss":"https://issuer.test","aud":"notes-local","sub":"owner","iat":1799999999,"exp":1800000060,"extra":true}`,
		`{"iss":"https://issuer.test","aud":"notes-local","sub":"owner","iat":1799999999,"exp":1800000060} trailing`,
	}
	for _, payload := range claims {
		unsigned := base64.RawURLEncoding.EncodeToString(header) + "." +
			base64.RawURLEncoding.EncodeToString([]byte(payload))
		signature := ed25519.Sign(privateKey, []byte(unsigned))
		assertion := unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
		if _, err := verifier.Verify(assertion, now); !errors.Is(err, accessadapter.ErrInvalidAssertion) {
			t.Fatalf("Verify() error = %v", err)
		}
	}
}
