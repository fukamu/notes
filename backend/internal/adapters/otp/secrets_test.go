package otpadapter

import (
	"bytes"
	"context"
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestSecretsGenerateUuidV7EightDigitsAndSalt(t *testing.T) {
	codeBytes := make([]byte, 4)
	binary.BigEndian.PutUint32(codeBytes, 12_345_678)
	reader := bytes.NewReader(append(append(bytes.Repeat([]byte{0x5a}, 10), codeBytes...), bytes.Repeat([]byte{0xa5}, 32)...))
	secrets, err := NewSecrets(reader, func() time.Time { return time.UnixMilli(1_700_000_000_123) })
	if err != nil {
		t.Fatal(err)
	}
	challengeID, err := secrets.CreateChallengeID(context.Background())
	if err != nil {
		t.Fatalf("CreateChallengeID() error = %v", err)
	}
	if _, err := identity.ParseEmailOtpChallengeID(challengeID); err != nil || challengeID[14] != '7' || !strings.Contains("89ab", challengeID[19:20]) {
		t.Fatalf("challenge ID = %q, %v", challengeID, err)
	}
	code, err := secrets.CreateCode(context.Background())
	if err != nil || code != "12345678" {
		t.Fatalf("CreateCode() = %q, %v", code, err)
	}
	if _, err := identity.ParseEmailOtpCode(code); err != nil {
		t.Fatal(err)
	}
	salt, err := secrets.CreateSalt(context.Background())
	if err != nil {
		t.Fatalf("CreateSalt() error = %v", err)
	}
	if _, err := identity.ParseEmailOtpSalt(salt); err != nil {
		t.Fatalf("salt = %q, %v", salt, err)
	}
}

func TestSecretsRejectUnavailableEntropyAndClock(t *testing.T) {
	if _, err := NewSecrets(nil, time.Now); err == nil {
		t.Fatal("nil entropy accepted")
	}
	secrets, err := NewSecrets(bytes.NewReader(nil), func() time.Time { return time.UnixMilli(1_700_000_000_123) })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := secrets.CreateChallengeID(context.Background()); err == nil {
		t.Fatal("entropy exhaustion accepted")
	}
	invalidClock, _ := NewSecrets(bytes.NewReader(bytes.Repeat([]byte{0}, 10)), func() time.Time { return time.UnixMilli(-1) })
	if _, err := invalidClock.CreateChallengeID(context.Background()); err == nil {
		t.Fatal("pre-epoch UUID clock accepted")
	}
}
