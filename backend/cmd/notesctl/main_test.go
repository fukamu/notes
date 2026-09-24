package main

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsUnknownCommand(t *testing.T) {
	t.Parallel()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"migrate"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
	}
}

func TestRunMigratesOnlyTheExplicitAllowlistedEnvironment(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"migrate", "--environment=test"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(_ context.Context, databaseURL string) error {
			called = true
			if !strings.Contains(databaseURL, "secret") {
				t.Fatal("migration did not receive the configured URL")
			}
			return nil
		},
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
	)
	if code != 0 || !called || stdout.String() != "migration complete\n" || stderr.Len() != 0 {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout.String(), stderr.String())
	}
}

func TestRunRefusesMigrationEnvironmentMismatchWithoutDisclosingURL(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"migrate", "--environment=local"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
	)
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "refused") {
		t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}
	if strings.Contains(stderr.String(), "secret") {
		t.Fatal("migration refusal disclosed credentials")
	}
}

func TestRunPreparesOnlyTheAllowlistedE2EDatabase(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"prepare-e2e", "--environment=test", "--allowed-subject=fukamu-notes-e2e-user"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(_ context.Context, databaseURL string, subject string) error {
			called = true
			if !strings.Contains(databaseURL, "secret") || subject != "fukamu-notes-e2e-user" {
				t.Fatal("prepare-e2e did not receive validated inputs")
			}
			return nil
		},
	)
	if code != 0 || !called || stdout.String() != "e2e database prepared\n" || stderr.Len() != 0 {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout.String(), stderr.String())
	}
}

func TestRunChecksConfigurationWithoutPrintingValues(t *testing.T) {
	staticDirectory := t.TempDir()
	t.Setenv("NOTES_ENVIRONMENT", "test")
	t.Setenv("NOTES_HTTP_ADDR", "127.0.0.1:8080")
	t.Setenv("NOTES_STATIC_DIR", staticDirectory)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"config", "check"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if stdout.String() != "configuration valid\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if strings.Contains(stdout.String(), filepath.Base(staticDirectory)) {
		t.Fatal("config check printed a configuration value")
	}
}

func TestRunFailsClosedWithoutConfiguration(t *testing.T) {
	for _, key := range []string{
		"NOTES_ENVIRONMENT",
		"NOTES_HTTP_ADDR",
		"NOTES_STATIC_DIR",
	} {
		t.Setenv(key, "")
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"config", "check"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if stderr.String() != "configuration invalid\n" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
