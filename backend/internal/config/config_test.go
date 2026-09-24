package config_test

import (
	"errors"
	"log/slog"
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
