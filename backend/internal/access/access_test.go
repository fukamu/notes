package access_test

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/access"
)

func TestParseSubject(t *testing.T) {
	t.Parallel()
	valid := []string{"opaque-owner", "ユーザー-1", strings.Repeat("a", 256)}
	for _, value := range valid {
		value := value
		t.Run("valid", func(t *testing.T) {
			t.Parallel()
			got, err := access.ParseSubject(value)
			if err != nil || string(got) != value {
				t.Fatalf("ParseSubject() = %q, %v", got, err)
			}
		})
	}
	invalid := []string{
		"",
		" owner",
		"owner ",
		"owner\nspoof",
		"owner\u0085spoof",
		strings.Repeat("a", 257),
		string([]byte{0xff}),
	}
	for _, value := range invalid {
		value := value
		t.Run("invalid", func(t *testing.T) {
			t.Parallel()
			if _, err := access.ParseSubject(value); !errors.Is(err, access.ErrInvalidSubject) {
				t.Fatalf("ParseSubject() error = %v", err)
			}
		})
	}
}

func TestLegacyOwnerRequiresExactOpaqueSubject(t *testing.T) {
	t.Parallel()
	owner, _ := access.ParseSubject("owner-subject")
	other, _ := access.ParseSubject("other-subject")
	if !access.IsLegacyOwner(owner, owner) {
		t.Fatal("exact owner was denied")
	}
	if access.IsLegacyOwner(other, owner) || access.IsLegacyOwner("", owner) {
		t.Fatal("non-owner was accepted")
	}
}

func TestRequireSameOrigin(t *testing.T) {
	t.Parallel()
	publicOrigin, err := url.Parse("https://notes.example")
	if err != nil {
		t.Fatal(err)
	}
	if err := access.RequireSameOrigin("https://notes.example", publicOrigin); err != nil {
		t.Fatalf("same origin error = %v", err)
	}
	for _, candidate := range []string{
		"",
		"https://evil.example",
		"http://notes.example",
		"https://notes.example/path",
		"https://notes.example?spoof=1",
		"https://user@notes.example",
	} {
		if err := access.RequireSameOrigin(candidate, publicOrigin); !errors.Is(err, access.ErrOriginDenied) {
			t.Fatalf("origin %q error = %v", candidate, err)
		}
	}
}
