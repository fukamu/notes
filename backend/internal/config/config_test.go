package config_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/config"
)

func validValues(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{
		"NOTES_ENVIRONMENT": "test",
		"NOTES_HTTP_ADDR":   "127.0.0.1:8080",
		"NOTES_STATIC_DIR":  t.TempDir(),
	}
}

func validLocalFixtureValues(t *testing.T) map[string]string {
	t.Helper()
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	privateRoot := t.TempDir()
	if err := os.Chmod(privateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	values := validValues(t)
	values["NOTES_APPLICATION_PROFILE"] = "local-fixture"
	values["NOTES_PRIVATE_AUTH_MODE"] = "local-signed"
	values["NOTES_DATABASE_URL"] = "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test?sslmode=disable"
	values["NOTES_PUBLIC_ORIGIN"] = "http://localhost:8080"
	values["NOTES_LOCAL_AUTH_ISSUER"] = "https://issuer.test/local"
	values["NOTES_LOCAL_AUTH_AUDIENCE"] = "notes-local"
	values["NOTES_LOCAL_AUTH_PUBLIC_KEY"] = base64.RawURLEncoding.EncodeToString(publicKey)
	values["NOTES_LEGACY_OWNER_SUBJECT"] = "opaque-owner"
	values["NOTES_LOCAL_FIXTURE_ROOT"] = privateRoot
	values["NOTES_LOCAL_FIXTURE_ACCOUNT_ID"] = "01999c20-9e33-7000-8000-000000000001"
	values["NOTES_LOCAL_FIXTURE_VAULT_ID"] = "01999c20-9e33-7000-8000-000000000002"
	values["NOTES_LOCAL_FIXTURE_SESSION_ID"] = "01999c20-9e33-7000-8000-000000000003"
	values["NOTES_LOCAL_FIXTURE_SESSION_EPOCH"] = "1"
	values["NOTES_LOCAL_FIXTURE_SESSION_TOKEN"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32))
	values["NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
	values["NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY"] = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x43}, 32))
	return values
}

func TestParseAcceptsExplicitSafeConfiguration(t *testing.T) {
	t.Parallel()
	values := validValues(t)
	values["NOTES_BODY_LIMIT_BYTES"] = "2048"
	values["NOTES_SHUTDOWN_TIMEOUT"] = "7s"
	values["NOTES_LOG_LEVEL"] = "warn"

	got, err := config.Parse(values)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if got.Environment != config.EnvironmentTest {
		t.Fatalf("Environment = %q", got.Environment)
	}
	if got.HTTPAddress != "127.0.0.1:8080" {
		t.Fatalf("HTTPAddress = %q", got.HTTPAddress)
	}
	if got.StaticDirectory != filepath.Clean(values["NOTES_STATIC_DIR"]) {
		t.Fatalf("StaticDirectory = %q", got.StaticDirectory)
	}
	if got.BodyLimit != 2048 {
		t.Fatalf("BodyLimit = %d", got.BodyLimit)
	}
	if got.ShutdownTimeout != 7*time.Second {
		t.Fatalf("ShutdownTimeout = %s", got.ShutdownTimeout)
	}
	if got.LogLevel != slog.LevelWarn {
		t.Fatalf("LogLevel = %s", got.LogLevel)
	}
}

func TestParseAppliesOnlyBoundedNonSecretDefaults(t *testing.T) {
	t.Parallel()
	got, err := config.Parse(validValues(t))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if got.BodyLimit != 4_000_000 {
		t.Fatalf("BodyLimit = %d", got.BodyLimit)
	}
	if got.ShutdownTimeout != 10*time.Second {
		t.Fatalf("ShutdownTimeout = %s", got.ShutdownTimeout)
	}
	if got.LogLevel != slog.LevelInfo {
		t.Fatalf("LogLevel = %s", got.LogLevel)
	}
	if got.PrivateRuntime != nil {
		t.Fatalf("private runtime enabled by default: %#v", got.PrivateRuntime)
	}
	if got.ApplicationProfile != config.ApplicationProfileDisabled || got.LocalFixture != nil {
		t.Fatalf("application profile = %q, local fixture = %#v", got.ApplicationProfile, got.LocalFixture)
	}
}

func TestParseAcceptsStrictLocalFixtureConfiguration(t *testing.T) {
	t.Parallel()
	values := validLocalFixtureValues(t)
	got, err := config.Parse(values)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	fixture := got.LocalFixture
	if got.ApplicationProfile != config.ApplicationProfileLocalFixture || fixture == nil {
		t.Fatalf("application profile = %q, local fixture = %#v", got.ApplicationProfile, fixture)
	}
	if fixture.DatabaseURL != got.PrivateRuntime.DatabaseURL ||
		fixture.PublicOrigin.String() != got.PrivateRuntime.PublicOrigin.String() {
		t.Fatal("local fixture did not reuse the private runtime database and origin")
	}
	if fixture.PublicOrigin == got.PrivateRuntime.PublicOrigin {
		t.Fatal("local fixture retained a mutable alias to the private runtime origin")
	}
	if fixture.AllowedSubject != got.PrivateRuntime.LegacyOwner {
		t.Fatal("local fixture did not reuse the private runtime launch subject")
	}
	if fixture.ObjectDirectory != filepath.Join(fixture.PrivateRoot, "objects") ||
		fixture.NonceDirectory != filepath.Join(fixture.PrivateRoot, "nonces") ||
		fixture.KeyDirectory != filepath.Join(fixture.PrivateRoot, "keys") {
		t.Fatalf("fixture directories = %#v", fixture)
	}
	if bytes.Equal(fixture.CursorHMACKey[:], fixture.DeletionHMACKey[:]) {
		t.Fatal("fixture secrets were not kept distinct")
	}
}

func TestParseIgnoresFixtureValuesUnlessExplicitlyEnabled(t *testing.T) {
	t.Parallel()
	values := validValues(t)
	values["NOTES_LOCAL_FIXTURE_SESSION_TOKEN"] = "invalid-sensitive-token"
	values["NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY"] = "invalid-sensitive-cursor-key"
	values["NOTES_LOCAL_FIXTURE_ROOT"] = "/missing/private/root"
	got, err := config.Parse(values)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if got.ApplicationProfile != config.ApplicationProfileDisabled || got.LocalFixture != nil {
		t.Fatalf("fixture was enabled implicitly: %#v", got.LocalFixture)
	}
}

func TestLoadNeverReadsFixtureSecretsForDisabledOrProductionProfiles(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		profile string
		env     string
	}{
		{name: "disabled", profile: "disabled", env: "test"},
		{name: "production rejection", profile: "local-fixture", env: "production"},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			values := validValues(t)
			values["NOTES_ENVIRONMENT"] = test.env
			values["NOTES_APPLICATION_PROFILE"] = test.profile
			requestedSecret := false
			_, _ = config.Load(func(key string) (string, bool) {
				if strings.HasPrefix(key, "NOTES_LOCAL_FIXTURE_") {
					requestedSecret = true
				}
				value, ok := values[key]
				return value, ok
			})
			if requestedSecret {
				t.Fatal("Load read local fixture secret material")
			}
		})
	}
}

func TestParseRejectsUnsafeLocalFixtureConfigurationWithoutEchoingValues(t *testing.T) {
	t.Parallel()
	base := validLocalFixtureValues(t)
	equalSecret := base["NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY"]
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "production", key: "NOTES_ENVIRONMENT", value: "production"},
		{name: "private auth disabled", key: "NOTES_PRIVATE_AUTH_MODE", value: "disabled"},
		{name: "wrong database", key: "NOTES_DATABASE_URL", value: "postgres://notes:secret@127.0.0.1/notes"},
		{name: "remote bind", key: "NOTES_HTTP_ADDR", value: "0.0.0.0:8080"},
		{name: "remote origin", key: "NOTES_PUBLIC_ORIGIN", value: "https://notes.example:8080"},
		{name: "https loopback origin", key: "NOTES_PUBLIC_ORIGIN", value: "https://localhost:8080"},
		{name: "origin port mismatch", key: "NOTES_PUBLIC_ORIGIN", value: "http://localhost:8081"},
		{name: "uppercase account", key: "NOTES_LOCAL_FIXTURE_ACCOUNT_ID", value: "01999C20-9E33-7000-8000-000000000001"},
		{name: "invalid vault", key: "NOTES_LOCAL_FIXTURE_VAULT_ID", value: "fixture-vault-sensitive"},
		{name: "invalid session", key: "NOTES_LOCAL_FIXTURE_SESSION_ID", value: "fixture-session-sensitive"},
		{name: "invalid epoch", key: "NOTES_LOCAL_FIXTURE_SESSION_EPOCH", value: "0"},
		{name: "invalid token", key: "NOTES_LOCAL_FIXTURE_SESSION_TOKEN", value: "fixture-token-sensitive"},
		{name: "short cursor key", key: "NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY", value: "c2hvcnQ"},
		{name: "padded deletion key", key: "NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY", value: strings.Repeat("A", 43) + "="},
		{name: "equal secrets", key: "NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY", value: equalSecret},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			values := maps.Clone(base)
			values[test.key] = test.value
			_, err := config.Parse(values)
			if err == nil {
				t.Fatal("Parse() accepted unsafe local fixture configuration")
			}
			if test.name != "production" && test.value != "" && strings.Contains(err.Error(), test.value) {
				t.Fatalf("error disclosed rejected input: %v", err)
			}
		})
	}
}

func TestParseRejectsUnsafeOrOverlappingFixtureRoot(t *testing.T) {
	t.Parallel()
	t.Run("static overlap", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		overlap := filepath.Join(values["NOTES_LOCAL_FIXTURE_ROOT"], "objects")
		if err := os.Mkdir(overlap, 0o700); err != nil {
			t.Fatal(err)
		}
		values["NOTES_STATIC_DIR"] = overlap
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_LOCAL_FIXTURE_ROOT")
	})
	t.Run("fixture inside static", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		root := filepath.Join(values["NOTES_STATIC_DIR"], "private")
		if err := os.Mkdir(root, 0o700); err != nil {
			t.Fatal(err)
		}
		values["NOTES_LOCAL_FIXTURE_ROOT"] = root
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_LOCAL_FIXTURE_ROOT")
	})
	t.Run("static symlink", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		link := filepath.Join(t.TempDir(), "static-link")
		if err := os.Symlink(values["NOTES_STATIC_DIR"], link); err != nil {
			t.Fatal(err)
		}
		values["NOTES_STATIC_DIR"] = link
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_STATIC_DIR")
	})
	t.Run("relative", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		values["NOTES_LOCAL_FIXTURE_ROOT"] = "private"
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_LOCAL_FIXTURE_ROOT")
	})
	t.Run("permissions", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		if err := os.Chmod(values["NOTES_LOCAL_FIXTURE_ROOT"], 0o750); err != nil {
			t.Fatal(err)
		}
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_LOCAL_FIXTURE_ROOT")
	})
	t.Run("symlink", func(t *testing.T) {
		values := validLocalFixtureValues(t)
		link := filepath.Join(t.TempDir(), "fixture-link")
		if err := os.Symlink(values["NOTES_LOCAL_FIXTURE_ROOT"], link); err != nil {
			t.Fatal(err)
		}
		values["NOTES_LOCAL_FIXTURE_ROOT"] = link
		_, err := config.Parse(values)
		assertConfigError(t, err, "NOTES_LOCAL_FIXTURE_ROOT")
	})
}

func TestParseRequiresEveryLocalFixtureBoundaryValue(t *testing.T) {
	t.Parallel()
	for _, key := range []string{
		"NOTES_LOCAL_FIXTURE_ROOT",
		"NOTES_LOCAL_FIXTURE_ACCOUNT_ID",
		"NOTES_LOCAL_FIXTURE_VAULT_ID",
		"NOTES_LOCAL_FIXTURE_SESSION_ID",
		"NOTES_LOCAL_FIXTURE_SESSION_EPOCH",
		"NOTES_LOCAL_FIXTURE_SESSION_TOKEN",
		"NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY",
		"NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY",
	} {
		key := key
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			values := validLocalFixtureValues(t)
			delete(values, key)
			_, err := config.Parse(values)
			assertConfigError(t, err, key)
		})
	}
}

func TestParseRejectsUnknownApplicationProfile(t *testing.T) {
	t.Parallel()
	values := validValues(t)
	values["NOTES_APPLICATION_PROFILE"] = "fixture-sensitive"
	_, err := config.Parse(values)
	assertConfigError(t, err, "NOTES_APPLICATION_PROFILE")
	if strings.Contains(err.Error(), values["NOTES_APPLICATION_PROFILE"]) {
		t.Fatal("application profile error disclosed rejected input")
	}
}

func TestParseAcceptsLocalSignedPrivateRuntime(t *testing.T) {
	t.Parallel()
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	values := validValues(t)
	values["NOTES_PRIVATE_AUTH_MODE"] = "local-signed"
	values["NOTES_DATABASE_URL"] = "postgres://notes:secret@127.0.0.1/notes"
	values["NOTES_DATABASE_MAX_CONNECTIONS"] = "7"
	values["NOTES_PUBLIC_ORIGIN"] = "http://127.0.0.1:8080"
	values["NOTES_LOCAL_AUTH_ISSUER"] = "https://issuer.test/local"
	values["NOTES_LOCAL_AUTH_AUDIENCE"] = "notes-local"
	values["NOTES_LOCAL_AUTH_PUBLIC_KEY"] = base64.RawURLEncoding.EncodeToString(publicKey)
	values["NOTES_LEGACY_OWNER_SUBJECT"] = "opaque-owner"
	got, err := config.Parse(values)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	privateRuntime := got.PrivateRuntime
	if privateRuntime == nil || privateRuntime.MaximumConnections != 7 ||
		privateRuntime.PublicOrigin.String() != "http://127.0.0.1:8080" ||
		privateRuntime.LegacyOwner != "opaque-owner" ||
		!strings.HasPrefix(privateRuntime.DatabaseURL, "postgres://") {
		t.Fatalf("private runtime = %#v", privateRuntime)
	}
}

func TestParseRejectsLocalSignedProductionAndUnsafePrivateValues(t *testing.T) {
	t.Parallel()
	publicKey, _, _ := ed25519.GenerateKey(nil)
	base := validValues(t)
	base["NOTES_PRIVATE_AUTH_MODE"] = "local-signed"
	base["NOTES_DATABASE_URL"] = "postgres://notes:secret@127.0.0.1/notes"
	base["NOTES_PUBLIC_ORIGIN"] = "http://127.0.0.1:8080"
	base["NOTES_LOCAL_AUTH_ISSUER"] = "https://issuer.test"
	base["NOTES_LOCAL_AUTH_AUDIENCE"] = "notes-local"
	base["NOTES_LOCAL_AUTH_PUBLIC_KEY"] = base64.RawURLEncoding.EncodeToString(publicKey)
	base["NOTES_LEGACY_OWNER_SUBJECT"] = "opaque-owner"

	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "production local mode", key: "NOTES_ENVIRONMENT", value: "production"},
		{name: "remote insecure origin", key: "NOTES_PUBLIC_ORIGIN", value: "http://notes.example"},
		{name: "origin path", key: "NOTES_PUBLIC_ORIGIN", value: "https://notes.example/path"},
		{name: "issuer query", key: "NOTES_LOCAL_AUTH_ISSUER", value: "https://issuer.test?secret=1"},
		{name: "invalid public key", key: "NOTES_LOCAL_AUTH_PUBLIC_KEY", value: "secret-key"},
		{name: "invalid owner", key: "NOTES_LEGACY_OWNER_SUBJECT", value: " owner"},
		{name: "too many connections", key: "NOTES_DATABASE_MAX_CONNECTIONS", value: "33"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			values := make(map[string]string, len(base))
			for key, value := range base {
				values[key] = value
			}
			values[test.key] = test.value
			_, err := config.Parse(values)
			if err == nil {
				t.Fatal("Parse() accepted unsafe private configuration")
			}
			if strings.Contains(err.Error(), "secret-key") || strings.Contains(err.Error(), "?secret=1") {
				t.Fatalf("error disclosed rejected input: %v", err)
			}
		})
	}
}

func TestParseFailsClosedForMissingRequiredConfiguration(t *testing.T) {
	t.Parallel()
	for _, key := range []string{
		"NOTES_ENVIRONMENT",
		"NOTES_HTTP_ADDR",
		"NOTES_STATIC_DIR",
	} {
		key := key
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			values := validValues(t)
			delete(values, key)
			_, err := config.Parse(values)
			assertConfigError(t, err, key)
		})
	}
}

func TestParseRejectsInvalidValuesWithoutEchoingThem(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "environment", key: "NOTES_ENVIRONMENT", value: "public"},
		{name: "address host", key: "NOTES_HTTP_ADDR", value: ":8080"},
		{name: "address port", key: "NOTES_HTTP_ADDR", value: "127.0.0.1:0"},
		{name: "static relative", key: "NOTES_STATIC_DIR", value: "./public"},
		{name: "body empty", key: "NOTES_BODY_LIMIT_BYTES", value: ""},
		{name: "body high", key: "NOTES_BODY_LIMIT_BYTES", value: "4000001"},
		{name: "shutdown short", key: "NOTES_SHUTDOWN_TIMEOUT", value: "999ms"},
		{name: "log level", key: "NOTES_LOG_LEVEL", value: "trace-secret"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			values := validValues(t)
			values[test.key] = test.value
			_, err := config.Parse(values)
			assertConfigError(t, err, test.key)
			if err != nil && test.value != "" && contains(err.Error(), test.value) {
				t.Fatalf("error echoed rejected value: %q", err)
			}
		})
	}
}

func TestLoadReadsOnlyKnownConfigurationKeys(t *testing.T) {
	t.Parallel()
	values := validValues(t)
	values["UNRELATED_SECRET"] = "must-not-be-read"
	requested := make(map[string]bool)

	_, err := config.Load(func(key string) (string, bool) {
		requested[key] = true
		value, ok := values[key]
		return value, ok
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if requested["UNRELATED_SECRET"] {
		t.Fatal("Load requested an unrelated environment value")
	}
	for _, key := range []string{
		"NOTES_PRIVATE_AUTH_MODE",
		"NOTES_DATABASE_URL",
		"NOTES_PUBLIC_ORIGIN",
		"NOTES_LOCAL_AUTH_PUBLIC_KEY",
	} {
		if !requested[key] {
			t.Fatalf("Load did not request known key %s", key)
		}
	}
}

func TestParseDatabaseKeepsTheSecretOpaque(t *testing.T) {
	t.Parallel()
	got, err := config.ParseDatabase(map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@localhost/fukamu_notes_go_test",
	})
	if err != nil {
		t.Fatalf("ParseDatabase() error = %v", err)
	}
	if got.Environment != config.EnvironmentTest || got.URL == "" {
		t.Fatalf("database configuration = %#v", got)
	}
}

func TestParseDatabaseRejectsInvalidInputWithoutEchoingIt(t *testing.T) {
	t.Parallel()
	value := "postgres://notes:secret@localhost/fukamu_notes_go_test\nleak"
	_, err := config.ParseDatabase(map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": value,
	})
	assertConfigError(t, err, "NOTES_DATABASE_URL")
	if err != nil && strings.Contains(err.Error(), "secret") {
		t.Fatal("database error disclosed credentials")
	}
}

func assertConfigError(t *testing.T, err error, key string) {
	t.Helper()
	var configError *config.Error
	if !errors.As(err, &configError) {
		t.Fatalf("error = %v, want *config.Error", err)
	}
	if configError.Key != key {
		t.Fatalf("error key = %q, want %q", configError.Key, key)
	}
}

func contains(source string, candidate string) bool {
	if candidate == "" {
		return false
	}
	for index := 0; index+len(candidate) <= len(source); index++ {
		if source[index:index+len(candidate)] == candidate {
			return true
		}
	}
	return false
}
