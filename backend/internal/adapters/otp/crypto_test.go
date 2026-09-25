package otpadapter

import (
	"context"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestHasherBindsEveryContextValueAndPepper(t *testing.T) {
	hasher := mustHasher(t, 'A')
	input := hashFixture(t)
	digest, err := hasher.CreateDigest(context.Background(), input)
	if err != nil {
		t.Fatalf("CreateDigest() error = %v", err)
	}
	if len(digest) != 43 {
		t.Fatalf("digest length = %d", len(digest))
	}
	expected, err := identity.ParseEmailOtpDigest(digest)
	if err != nil {
		t.Fatal(err)
	}
	matched, err := hasher.MatchesDigest(context.Background(), input, expected)
	if err != nil || !matched {
		t.Fatalf("MatchesDigest() = %t, %v", matched, err)
	}
	wrongCode := input
	wrongCode.Code = mustCode(t, "87654321")
	if matched, err := hasher.MatchesDigest(context.Background(), wrongCode, expected); err != nil || matched {
		t.Fatalf("wrong-code match = %t, %v", matched, err)
	}
	otherPepper := mustHasher(t, 'B')
	if matched, err := otherPepper.MatchesDigest(context.Background(), input, expected); err != nil || matched {
		t.Fatalf("other-pepper match = %t, %v", matched, err)
	}
	otherAddress := input
	otherAddress.Address = mustAddress(t, "other@example.com")
	if matched, err := hasher.MatchesDigest(context.Background(), otherAddress, expected); err != nil || matched {
		t.Fatalf("other-address match = %t, %v", matched, err)
	}
}

func TestHasherRejectsMalformedInputs(t *testing.T) {
	if _, err := NewHasher([]byte("short")); err == nil {
		t.Fatal("short pepper accepted")
	}
	hasher := mustHasher(t, 'A')
	input := hashFixture(t)
	input.Code = "1234"
	if _, err := hasher.CreateDigest(context.Background(), input); err == nil {
		t.Fatal("malformed code accepted")
	}
	if _, err := hasher.MatchesDigest(context.Background(), hashFixture(t), "not-a-digest"); err == nil {
		t.Fatal("malformed expected digest accepted")
	}
}

func TestAbuseKeyDeriverSeparatesDimensionsAndScopes(t *testing.T) {
	deriver, err := NewAbuseKeyDeriver([]byte(strings.Repeat("K", 32)))
	if err != nil {
		t.Fatal(err)
	}
	account := mustAccount(t, "01991f20-61d2-7000-8000-000000000101")
	keys, err := deriver.Derive(mustAddress(t, "Person@Example.COM"), "trusted-prefix:203.0.113.0/24", &account)
	if err != nil {
		t.Fatalf("Derive() error = %v", err)
	}
	if keys.Account == nil || keys.Address == keys.Network || keys.Address == *keys.Account || keys.Network == *keys.Account {
		t.Fatalf("keys were not dimension-separated: %#v", keys)
	}
	repeated, err := deriver.Derive(mustAddress(t, "Person@example.com"), "trusted-prefix:203.0.113.0/24", &account)
	if err != nil || repeated.Address != keys.Address || repeated.Network != keys.Network ||
		repeated.Account == nil || *repeated.Account != *keys.Account {
		t.Fatalf("repeat Derive() = %#v, %v", repeated, err)
	}
	otherNetwork, err := deriver.Derive(mustAddress(t, "Person@example.com"), "trusted-prefix:198.51.100.0/24", nil)
	if err != nil || otherNetwork.Network == keys.Network || otherNetwork.Account != nil {
		t.Fatalf("other-network Derive() = %#v, %v", otherNetwork, err)
	}
}

func hashFixture(t *testing.T) identity.EmailOtpHashInput {
	t.Helper()
	challengeID, err := identity.ParseEmailOtpChallengeID("01991f20-61d2-7000-8000-000000000501")
	if err != nil {
		t.Fatal(err)
	}
	salt, err := identity.ParseEmailOtpSalt("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	return identity.EmailOtpHashInput{
		ChallengeID: challengeID, Address: mustAddress(t, "Person@example.com"),
		Code: mustCode(t, "12345678"), Salt: salt,
	}
}

func mustHasher(t *testing.T, repeated byte) *Hasher {
	t.Helper()
	hasher, err := NewHasher([]byte(strings.Repeat(string(repeated), 32)))
	if err != nil {
		t.Fatal(err)
	}
	return hasher
}

func mustAddress(t *testing.T, value string) identity.EmailOtpAddress {
	t.Helper()
	parsed, err := identity.ParseEmailOtpAddress(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustCode(t *testing.T, value string) identity.EmailOtpCode {
	t.Helper()
	parsed, err := identity.ParseEmailOtpCode(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustAccount(t *testing.T, value string) identity.AccountID {
	t.Helper()
	parsed, err := identity.ParseAccountID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
